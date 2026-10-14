import { Button } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { CloudOff, File as FileIcon, FolderOpen, GitCompare } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { toWorktreeId, useRepos } from "@/dashboard";
import { ContinueOnHostDialog } from "../dashboard/components/ContinueOnHostDialog";
import { timeAgo, useHostSeen } from "../dashboard/hooks/use-host-status";
import { trpc } from "../lib/trpc-client";

/**
 * Whether a worktree's host is offline, when the hub last saw it, and when the hub last took a
 * checkpoint of the worktree.
 */
export function useOfflineWorktree(worktreeId: string): {
  offline: boolean;
  hostId: string | null;
  hostName: string;
  lastSeenAt: number | null;
  checkpointAt: number | null;
} {
  const { repos } = useRepos();
  const wt = repos
    .flatMap((r) => r.worktrees.map((w) => ({ repo: r, wt: w })))
    .find(({ repo, wt }) => toWorktreeId(repo.name, wt.name, wt.hostId) === worktreeId)?.wt;
  const seen = useHostSeen(wt?.hostId);
  return {
    offline: seen.offline && !wt?.supersededBy,
    hostId: wt?.hostId ?? null,
    hostName: seen.name,
    lastSeenAt: seen.lastSeenAt,
    checkpointAt: wt?.lastCheckpointAt ?? null,
  };
}

// Which offline worktrees show the read-only checkpoint instead of the notice. Kept in memory: a
// reload starts from the notice again.
const viewing = new Set<string>();
const viewingListeners = new Set<() => void>();
let viewingVersion = 0;

function setViewingCheckpoint(worktreeId: string, on: boolean): void {
  if (viewing.has(worktreeId) === on) return;
  if (on) viewing.add(worktreeId);
  else viewing.delete(worktreeId);
  viewingVersion++;
  for (const listener of viewingListeners) listener();
}

function useViewingCheckpoint(worktreeId: string): boolean {
  useSyncExternalStore(
    (listener) => {
      viewingListeners.add(listener);
      return () => viewingListeners.delete(listener);
    },
    () => viewingVersion,
  );
  return viewing.has(worktreeId);
}

/**
 * Whether the worktree is read from its checkpoint: its host is offline, a checkpoint exists and
 * the person chose to look at it from the notice.
 */
export function useOfflineCheckpoint(worktreeId: string): {
  active: boolean;
  offline: boolean;
  at: number | null;
} {
  const { offline, checkpointAt } = useOfflineWorktree(worktreeId);
  const chosen = useViewingCheckpoint(worktreeId);
  return { active: offline && checkpointAt !== null && chosen, offline, at: checkpointAt };
}

/** The age text of a timestamp, with the exact time on hover. */
function Ago({ at }: { at: number }) {
  return <span title={new Date(at).toLocaleString()}>{timeAgo(at)}</span>;
}

/**
 * The notice above a worktree whose host is offline: where it is, when it was last seen and
 * checkpointed, and a button to open it on another host. When the offer is blocked it says why and
 * shows no button. The read-only view of the checkpoint stays behind a link.
 */
export function OfflineWorktreeNotice({ worktreeId }: { worktreeId: string }) {
  const { offline, hostName, lastSeenAt, checkpointAt } = useOfflineWorktree(worktreeId);
  const chosen = useViewingCheckpoint(worktreeId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const offerQuery = useQuery({
    queryKey: ["follow.offer", worktreeId],
    queryFn: () => trpc.follow.offer.query({ worktreeId }),
    enabled: offline,
    refetchInterval: 15_000,
  });
  if (!offline) return null;
  const offer = offerQuery.data;
  const blocked = offer?.blocked;
  return (
    <div
      data-testid="offline-notice"
      data-has-checkpoint={checkpointAt !== null ? "true" : "false"}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-muted/40 px-3 py-2 text-[12px]"
    >
      <CloudOff className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 basis-60 space-y-0.5">
        <p data-testid="offline-notice__host" className="text-foreground">
          {hostName} is offline
          {lastSeenAt !== null ? (
            <>
              {" "}
              (last seen <Ago at={lastSeenAt} />)
            </>
          ) : null}
          .{" "}
          {checkpointAt !== null ? (
            <>
              Last checkpoint <Ago at={checkpointAt} />.
            </>
          ) : (
            "The hub has no checkpoint of this worktree."
          )}
        </p>
        {blocked ? (
          <p data-testid="offline-notice__blocked" className="text-muted-foreground">
            {blocked.message}
          </p>
        ) : null}
      </div>
      {checkpointAt !== null ? (
        <button
          type="button"
          data-testid="offline-notice__view-checkpoint"
          className="text-muted-foreground underline hover:text-foreground"
          onClick={() => setViewingCheckpoint(worktreeId, !chosen)}
        >
          {chosen ? "Hide checkpoint" : "View checkpoint (read-only)"}
        </button>
      ) : null}
      {offer && !blocked ? (
        <Button
          size="sm"
          data-testid="offline-notice__open-elsewhere"
          onClick={() => setDialogOpen(true)}
        >
          Open on another host
        </Button>
      ) : null}
      {dialogOpen && offer ? (
        <ContinueOnHostDialog offer={offer} onClose={() => setDialogOpen(false)} />
      ) : null}
    </div>
  );
}

/** The right panel of an offline worktree that is not read from its checkpoint. */
export function OfflineSidepanelPlaceholder({ worktreeId }: { worktreeId: string }) {
  const { checkpointAt } = useOfflineWorktree(worktreeId);
  return (
    <div
      data-testid="offline-sidepanel"
      className="flex h-full flex-col items-start gap-2 p-3 text-xs text-muted-foreground"
    >
      <p>The host is offline, so its files and changes are not available.</p>
      {checkpointAt !== null ? (
        <button
          type="button"
          data-testid="offline-sidepanel__view-checkpoint"
          className="underline hover:text-foreground"
          onClick={() => setViewingCheckpoint(worktreeId, true)}
        >
          View the checkpoint (read-only)
        </button>
      ) : null}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  T: "Type changed",
};

/** Read-only Explorer and Changes of the newest checkpoint, in place of the live panels. */
export function CheckpointSidepanel({ worktreeId }: { worktreeId: string }) {
  const [tab, setTab] = useState<"explorer" | "changes">("changes");
  const [selected, setSelected] = useState<string | null>(null);

  const changes = useQuery({
    queryKey: ["checkpoints.changes", worktreeId],
    queryFn: () => trpc.checkpoints.changes.query({ worktreeId }),
  });
  const files = useQuery({
    queryKey: ["checkpoints.files", worktreeId],
    queryFn: () => trpc.checkpoints.files.query({ worktreeId }),
    enabled: tab === "explorer",
  });
  const diff = useQuery({
    queryKey: ["checkpoints.diff", worktreeId, selected],
    queryFn: () => trpc.checkpoints.diff.query({ worktreeId, path: selected as string }),
    enabled: tab === "changes" && selected !== null,
  });
  const file = useQuery({
    queryKey: ["checkpoints.file", worktreeId, selected],
    queryFn: () => trpc.checkpoints.file.query({ worktreeId, path: selected as string }),
    enabled: tab === "explorer" && selected !== null,
  });

  const tabButton = (id: "explorer" | "changes", label: string, Icon: typeof FolderOpen) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      data-testid={`checkpoint-panel__tab--${id}`}
      onClick={() => {
        setTab(id);
        setSelected(null);
      }}
      className={`flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium ${
        tab === id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="checkpoint-panel">
      <div
        role="tablist"
        className="flex h-[38px] shrink-0 items-center gap-0.5 border-b border-border px-1.5"
      >
        {tabButton("explorer", "Explorer", FolderOpen)}
        {tabButton("changes", "Changes", GitCompare)}
      </div>
      <div className="min-h-0 flex-1 overflow-auto text-[13px]">
        {tab === "changes" ? (
          <>
            {changes.isError ? (
              <p
                role="alert"
                className="p-3 text-xs text-destructive"
                data-testid="checkpoint-panel__error"
              >
                {String((changes.error as Error).message)}
              </p>
            ) : null}
            {changes.data && changes.data.files.length === 0 ? (
              <p
                className="p-3 text-xs text-muted-foreground"
                data-testid="checkpoint-panel__no-changes"
              >
                The checkpoint has no uncommitted changes.
              </p>
            ) : null}
            <ul>
              {(changes.data?.files ?? []).map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    data-testid="checkpoint-panel__change"
                    data-path={f.path}
                    data-status={f.status}
                    onClick={() => setSelected(f.path)}
                    className={`flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-accent/50 ${selected === f.path ? "bg-accent" : ""}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{f.path}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {STATUS_LABEL[f.status] ?? f.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {selected ? (
              <pre
                data-testid="checkpoint-panel__diff"
                className="m-2 overflow-auto rounded-md border border-border p-2 font-mono text-xs"
              >
                {diff.data?.diff ?? "Loading…"}
              </pre>
            ) : null}
          </>
        ) : (
          <>
            {files.isError ? (
              <p
                role="alert"
                className="p-3 text-xs text-destructive"
                data-testid="checkpoint-panel__error"
              >
                {String((files.error as Error).message)}
              </p>
            ) : null}
            <ul>
              {(files.data?.paths ?? []).map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    data-testid="checkpoint-panel__file"
                    data-path={p}
                    onClick={() => setSelected(p)}
                    className={`flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-accent/50 ${selected === p ? "bg-accent" : ""}`}
                  >
                    <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{p}</span>
                  </button>
                </li>
              ))}
            </ul>
            {selected ? (
              <pre
                data-testid="checkpoint-panel__content"
                className="m-2 overflow-auto rounded-md border border-border p-2 font-mono text-xs"
              >
                {file.data
                  ? file.data.truncated
                    ? `File is too large to show (${file.data.size} bytes).`
                    : file.data.binary
                      ? "Binary file."
                      : file.data.content
                  : "Loading…"}
              </pre>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
