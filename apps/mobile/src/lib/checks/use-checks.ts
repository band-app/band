/**
 * The Checks view's data and actions, through the calls the web's GitHub plugin makes
 * (`apps/web/src/plugins/client-plugin-host.ts`): `reviews.forWorktree` for the pull request and
 * its checks, `reviews.rerunChecks` to run jobs again and `agentSessions.launch` for the Fix agent.
 * GitHub tokens stay on the hub.
 *
 * The list is read every 30 s while a check runs and every 2 minutes otherwise, and again when
 * the status stream reports a new CI state for the worktree, so a check that finishes shows at
 * once. After a re-run GitHub takes a moment to list the new job, so the check shows as queued
 * and the list is read every 5 s until the job is no longer the finished one.
 */

import {
  asQueued,
  type CheckLike,
  canRerun,
  fixPrompt,
  isUnfinished,
  POLL_RUNNING_MS,
  POLL_SETTLED_MS,
  RERUN_POLL_MS,
  rerunFailedPlan,
  rerunOneTarget,
} from "@band-app/client/checks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useHubSession } from "../hub-session";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useWorktreeChecks(worktreeId: string, branch: string) {
  const { client, feed } = useHubSession();
  const queryClient = useQueryClient();
  const [requeued, setRequeued] = useState<ReadonlySet<string>>(new Set());
  const [rerunning, setRerunning] = useState<ReadonlySet<string>>(new Set());
  const [rerunErrors, setRerunErrors] = useState<Readonly<Record<string, string>>>({});
  const [rerunFailedError, setRerunFailedError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);

  const query = useQuery({
    queryKey: ["reviews.forWorktree", worktreeId],
    queryFn: () => client.reviews.forWorktree.query({ worktreeId }),
    refetchInterval: (q) => {
      if (requeued.size > 0) return RERUN_POLL_MS;
      const data = q.state.data;
      // The report's own state says "failure" while one job failed and another still runs.
      const running = data?.status === "ok" && data.checks.checks.some(isUnfinished);
      return running ? POLL_RUNNING_MS : POLL_SETTLED_MS;
    },
  });

  // A new CI state in the status stream means the checks changed.
  const ciState = useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().state.branches.get(worktreeId)?.ci?.state,
  );
  const refetch = query.refetch;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new CI state is the trigger
  useEffect(() => {
    void refetch();
  }, [ciState, refetch]);

  const data = query.data?.status === "ok" ? query.data : null;
  const checks = data?.checks.checks;
  // A requeued check goes back to the list's own state once GitHub reports it running or drops
  // the old job.
  useEffect(() => {
    if (requeued.size === 0 || !checks) return;
    const stale = new Set(checks.filter((c) => requeued.has(c.id) && canRerun(c)).map((c) => c.id));
    if (stale.size !== requeued.size) setRequeued(stale);
  }, [checks, requeued]);

  const shown = useMemo(
    () => (checks ?? []).map((c) => (requeued.has(c.id) ? asQueued(c) : c)),
    [checks, requeued],
  );

  const rerun = useCallback(
    async (covered: CheckLike[], targets: ReturnType<typeof rerunOneTarget>) => {
      const ids = covered.map((c) => c.id);
      setRerunning((prev) => new Set([...prev, ...ids]));
      try {
        await client.reviews.rerunChecks.mutate({ worktreeId, targets });
        setRequeued((prev) => new Set([...prev, ...ids]));
        setRerunErrors((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([k]) => !ids.includes(k))),
        );
      } finally {
        setRerunning((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
        void queryClient.invalidateQueries({ queryKey: ["reviews.forWorktree", worktreeId] });
      }
    },
    [client, worktreeId, queryClient],
  );

  const rerunOne = useCallback(
    async (check: CheckLike) => {
      try {
        await rerun([check], rerunOneTarget(check));
      } catch (err) {
        setRerunErrors((prev) => ({ ...prev, [check.id]: errorMessage(err) }));
      }
    },
    [rerun],
  );

  const failedPlan = useMemo(() => rerunFailedPlan(checks ?? []), [checks]);
  const rerunFailed = useCallback(async () => {
    setRerunFailedError(null);
    try {
      await rerun(failedPlan.covered, failedPlan.targets);
    } catch (err) {
      setRerunFailedError(errorMessage(err));
    }
  }, [rerun, failedPlan]);

  /** Starts the Fix agent as a chat and returns its id. */
  const startFix = useCallback(async (): Promise<string> => {
    setFixing(true);
    try {
      const failing = (checks ?? []).filter((c) => c.state === "failure");
      const result = await client.agentSessions.launch.mutate({
        worktreeId,
        prompt: fixPrompt(branch, data?.review ?? null, failing),
        mode: "gui",
      });
      if (!result.chatId) throw new Error(result.notice ?? "The hub started no chat.");
      void queryClient.invalidateQueries({ queryKey: ["chats.list", worktreeId] });
      return result.chatId;
    } finally {
      setFixing(false);
    }
  }, [client, worktreeId, branch, checks, data, queryClient]);

  return {
    query,
    /** The review and its checks, or null while loading or when the hub reports a problem. */
    data,
    shown,
    rerunning,
    rerunErrors,
    rerunFailedError,
    canRerunFailed: failedPlan.targets.length > 0,
    rerunFailedBusy: failedPlan.covered.some((c) => rerunning.has(c.id)),
    rerunOne,
    rerunFailed,
    startFix,
    fixing,
  };
}
