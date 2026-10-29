import type { CheckRun, ChecksReport, ReviewAction, ReviewInfo } from "@band-app/plugin-api";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from "@band-app/ui";
import {
  ChevronDown,
  ChevronRight,
  CircleX,
  ExternalLink,
  Loader,
  RotateCw,
  WandSparkles,
} from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { clientPluginHost as host } from "../../plugins/client-plugin-host";
import {
  CheckStateIcon,
  checkDuration,
  checkElapsed,
  checkStateLabel,
  countChecks,
  isCountingUp,
} from "./check-status";
import { runReviewAction, useReviewProviderInfo } from "./review-query";
import { useSectionOpen } from "./section-state";

function fixPrompt(
  branch: string,
  review: ReviewInfo | null,
  failing: CheckRun[],
  fixHint: string,
): string {
  const subject = review ? `pull request #${review.number} (${review.title})` : `branch ${branch}`;
  const lines = failing.map((check) => {
    const name = check.workflowName ? `${check.workflowName} / ${check.name}` : check.name;
    return `- ${name}${check.url ? `: ${check.url}` : ""}`;
  });
  return [
    `These CI checks are failing on ${subject}:`,
    ...lines,
    "",
    `Read the failing job logs${fixHint ? ` (${fixHint})` : ""}, fix the causes, run the relevant checks locally, and push the fix.`,
  ].join("\n");
}

/**
 * The current time, updated every second while `ticking`. One timer for the
 * whole list, so running checks count up together.
 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

// While a re-run waits to show up on GitHub, ask for the checks this often.
const RERUN_POLL_MS = 5000;

/** A job that finished can be run again; one still going cannot. */
function isFinished(check: CheckRun): boolean {
  return check.state !== "running" && check.state !== "pending";
}

/** The review's re-run action for one check row, when the provider offers one. */
function rowAction(actions: ReviewAction[], check: CheckRun): ReviewAction | undefined {
  return actions.find((a) => a.placement === "check" && a.args?.checkId === check.id);
}

/** Header actions that re-run checks show in the failing banner. */
function bannerActions(actions: ReviewAction[]): ReviewAction[] {
  return actions.filter((a) => a.placement === "header" && a.icon === "rerun");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The failing banner with Fix, the summary row and the list of checks. */
export function ChecksSection({
  worktreeId,
  branch,
  review,
  checks,
  visible,
  refetch,
}: {
  worktreeId: string;
  branch: string;
  review: ReviewInfo | null;
  checks: ChecksReport;
  /** Whether the tab is on screen; the elapsed-time timer only runs then. */
  visible: boolean;
  /** Asks for fresh checks; called every few seconds while a re-run is not yet listed. */
  refetch: () => void;
}) {
  const provider = useReviewProviderInfo();
  const actions = checks.actions ?? [];
  const [open, setOpen] = useSectionOpen("checks");
  const now = useNow(visible && open && checks.checks.some(isCountingUp));
  const [fixState, setFixState] = useState<"idle" | "starting" | "started">("idle");
  const [fixPaneId, setFixPaneId] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  // Check ids with a re-run request in flight, and ones GitHub accepted that the list does not show yet.
  const [rerunning, setRerunning] = useState<ReadonlySet<string>>(new Set());
  const [requeued, setRequeued] = useState<ReadonlySet<string>>(new Set());
  const [rerunErrors, setRerunErrors] = useState<Readonly<Record<string, string>>>({});
  const [rerunFailedError, setRerunFailedError] = useState<string | null>(null);

  // A requeued check goes back to the list's own state once GitHub reports it running or drops the old job.
  useEffect(() => {
    if (requeued.size === 0) return;
    const stale = new Set(
      checks.checks.filter((c) => requeued.has(c.id) && isFinished(c)).map((c) => c.id),
    );
    if (stale.size !== requeued.size) setRequeued(stale);
  }, [checks, requeued]);

  const waiting = requeued.size > 0;
  useEffect(() => {
    if (!waiting || !visible) return;
    const timer = setInterval(refetch, RERUN_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, visible, refetch]);

  const rerun = useCallback(
    async (targets: CheckRun[], toRun: ReviewAction[]) => {
      const ids = targets.map((c) => c.id);
      setRerunning((prev) => new Set([...prev, ...ids]));
      try {
        for (const action of toRun) await runReviewAction(worktreeId, action.id, action.args);
        setRequeued((prev) => new Set([...prev, ...ids]));
        setRerunErrors((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([k]) => !ids.includes(k))),
        );
      } finally {
        setRerunning((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      }
    },
    [worktreeId],
  );

  const rerunOne = useCallback(
    async (check: CheckRun, action: ReviewAction) => {
      try {
        await rerun([check], [action]);
      } catch (err) {
        setRerunErrors((prev) => ({ ...prev, [check.id]: errorMessage(err) }));
      }
    },
    [rerun],
  );

  if (checks.checks.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground" data-testid="pr-checks__empty">
        {review ? "No checks reported for this pull request." : "No CI jobs ran on this branch."}
      </p>
    );
  }

  const counts = countChecks(checks.checks);
  const failing = checks.checks.filter((c) => c.state === "failure");

  // One request per workflow run, however many of its jobs failed.
  const failedActions = bannerActions(actions);
  const rerunnableFailing = failing.filter((c) => rowAction(actions, c) && isFinished(c));
  const rerunFailed = async () => {
    setRerunFailedError(null);
    try {
      await rerun(rerunnableFailing, failedActions);
    } catch (err) {
      setRerunFailedError(errorMessage(err));
    }
  };
  const rerunFailedBusy = rerunnableFailing.some((c) => rerunning.has(c.id));

  const startFix = async () => {
    setFixState("starting");
    setFixError(null);
    try {
      const started = await host.startAgent(
        worktreeId,
        fixPrompt(branch, review, failing, provider.fixHint),
      );
      setFixPaneId(started.chatId ?? started.terminalId ?? null);
      setFixState("started");
    } catch (err) {
      setFixState("idle");
      setFixError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col">
      {failing.length > 0 && (
        <div
          className="flex items-center gap-2 border-b border-border px-3 py-2.5"
          data-testid="pr-checks__failing-banner"
        >
          <CircleX className="size-4 shrink-0 text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <p
              className="text-xs font-semibold"
              data-testid="pr-checks__failing-count"
              data-count={failing.length}
            >
              {failing.length} failing {failing.length === 1 ? "check" : "checks"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {rerunFailedError ??
                fixError ??
                (fixState === "started"
                  ? "An agent is fixing these checks"
                  : "Inspect details or start an AI fix pass.")}
              {!fixError && fixState === "started" && fixPaneId && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => host.openPane(worktreeId, fixPaneId)}
                    data-testid="pr-checks__open-agent"
                    className="underline hover:text-foreground"
                  >
                    Open
                  </button>
                </>
              )}
            </p>
          </div>
          {failedActions.length > 0 && (
            <button
              type="button"
              onClick={() => void rerunFailed()}
              disabled={rerunFailedBusy}
              data-testid="pr-checks__rerun-failed"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-accent disabled:opacity-50"
            >
              {rerunFailedBusy ? (
                <Loader className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCw className="size-3.5" aria-hidden />
              )}
              {failedActions[0]?.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => void startFix()}
            disabled={fixState === "starting"}
            data-testid="pr-checks__fix"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            <WandSparkles className="size-3.5" aria-hidden />
            Fix
          </button>
        </div>
      )}
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-[11px] text-muted-foreground hover:bg-accent/50"
            data-testid="pr-checks__summary"
            aria-expanded={open}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            <span className="font-semibold text-foreground">Checks</span>
            {counts.passing > 0 && (
              <SummaryCount state="success" count={counts.passing} label="passing" />
            )}
            {counts.failing > 0 && (
              <SummaryCount state="failure" count={counts.failing} label="failing" />
            )}
            {counts.pending > 0 && (
              <SummaryCount state="running" count={counts.pending} label="pending" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul data-testid="pr-checks__list">
            {checks.checks.map((check) => (
              <CheckRow
                key={check.id}
                check={requeued.has(check.id) ? asQueued(check) : check}
                rerunning={rerunning.has(check.id)}
                rerunError={rerunErrors[check.id] ?? null}
                rerunAction={rowAction(actions, check)}
                onRerun={rerunOne}
                // Rows without a growing elapsed time keep a stable prop and skip the tick.
                now={isCountingUp(check) ? now : 0}
              />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** The check as the list shows it right after a re-run was accepted. */
function asQueued(check: CheckRun): CheckRun {
  return { ...check, state: "pending", startedAt: null, completedAt: null, description: null };
}

function SummaryCount({
  state,
  count,
  label,
}: {
  state: "success" | "failure" | "running";
  count: number;
  label: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap"
      data-testid={`pr-checks__summary-${label}`}
      data-count={count}
    >
      <CheckStateIcon
        state={state}
        className={cn("size-3.5", state === "running" && "animate-none")}
      />
      {count} {label}
    </span>
  );
}

const CheckRow = memo(function CheckRow({
  check,
  now,
  rerunning,
  rerunError,
  rerunAction,
  onRerun,
}: {
  check: CheckRun;
  now: number;
  rerunning: boolean;
  rerunError: string | null;
  rerunAction: ReviewAction | undefined;
  onRerun: (check: CheckRun, action: ReviewAction) => void;
}) {
  const provider = useReviewProviderInfo();
  const [open, setOpen] = useState(false);
  const duration = checkDuration(check) ?? checkElapsed(check, now);
  return (
    <li
      className="border-b border-border/60"
      data-testid="pr-checks__check"
      data-check-state={check.state}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              aria-expanded={open}
              data-testid="pr-checks__check-toggle"
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <CheckStateIcon state={check.state} />
              <span
                className="min-w-0 flex-1 truncate text-[13px]"
                data-testid="pr-checks__check-name"
              >
                {check.name}
              </span>
              <span
                className="shrink-0 text-[11px] text-muted-foreground"
                data-testid="pr-checks__check-state"
              >
                {checkStateLabel(check.state)}
              </span>
            </button>
          </CollapsibleTrigger>
          {((rerunAction && isFinished(check)) || rerunning) && (
            <button
              type="button"
              aria-label={`Re-run ${check.name}`}
              title={rerunAction?.label ?? "Re-run job"}
              disabled={rerunning}
              onClick={() => rerunAction && onRerun(check, rerunAction)}
              data-testid="pr-checks__check-rerun"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {rerunning ? (
                <Loader className="size-3.5 animate-spin" />
              ) : (
                <RotateCw className="size-3.5" />
              )}
            </button>
          )}
          {check.url && (
            <a
              href={check.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${check.name} on ${provider.name}`}
              data-testid="pr-checks__check-link"
              onClick={(e) => {
                // Electron would navigate the dashboard's own webview.
                e.preventDefault();
                host.openUrl(check.url as string);
              }}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
        {rerunError && (
          <p
            className="px-3 pb-2 pl-[42px] text-[11px] text-danger"
            role="alert"
            data-testid="pr-checks__check-rerun-error"
          >
            {rerunError}
          </p>
        )}
        <CollapsibleContent>
          <dl
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pb-2.5 pl-[42px] text-[11px]"
            data-testid="pr-checks__check-details"
          >
            {check.workflowName && (
              <>
                <dt className="text-muted-foreground">Workflow</dt>
                <dd className="min-w-0 truncate">{check.workflowName}</dd>
              </>
            )}
            {check.description && (
              <>
                <dt className="text-muted-foreground">Result</dt>
                <dd className="min-w-0">{check.description}</dd>
              </>
            )}
            {check.startedAt && (
              <>
                <dt className="text-muted-foreground">Started</dt>
                <dd>{new Date(check.startedAt).toLocaleString()}</dd>
              </>
            )}
            {duration && (
              <>
                <dt className="text-muted-foreground">Duration</dt>
                <dd data-testid="pr-checks__check-duration">{duration}</dd>
              </>
            )}
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
});
