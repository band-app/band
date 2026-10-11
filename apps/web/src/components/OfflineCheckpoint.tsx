import { useQuery } from "@tanstack/react-query";
import { CloudOff, File as FileIcon, FolderOpen, GitCompare } from "lucide-react";
import { useState } from "react";
import { toWorktreeId, useRepos } from "@/dashboard";
import { timeAgo, useHostOffline } from "../dashboard/hooks/use-host-status";
import { trpc } from "../lib/trpc-client";

/**
 * Whether a worktree's host is offline and the hub holds a checkpoint of it. Then the worktree is
 * read from the checkpoint, read-only, until the host is back.
 */
export function useOfflineCheckpoint(worktreeId: string): {
  active: boolean;
  offline: boolean;
  at: number | null;
} {
  const { repos } = useRepos();
  const wt = repos
    .flatMap((r) => r.worktrees.map((w) => ({ repo: r, wt: w })))
    .find(({ repo, wt }) => toWorktreeId(repo.name, wt.name, wt.hostId) === worktreeId)?.wt;
  const offline = useHostOffline(wt?.hostId);
  const at = wt?.lastCheckpointAt ?? null;
  return { active: offline && at !== null, offline, at };
}

/** The banner above a worktree whose host is offline. */
export function OfflineCheckpointBar({ worktreeId }: { worktreeId: string }) {
  const { offline, at } = useOfflineCheckpoint(worktreeId);
  if (!offline) return null;
  return (
    <div
      data-testid="offline-checkpoint"
      data-has-checkpoint={at !== null ? "true" : "false"}
      className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1 text-[12px] text-muted-foreground"
    >
      <CloudOff className="size-3.5" />
      {at !== null ? (
        <span>
          Host offline. Showing the checkpoint from{" "}
          <span title={new Date(at).toLocaleString()}>{timeAgo(at)}</span>, read-only. Terminals,
          dev servers and the desktop need the host.
        </span>
      ) : (
        <span>Host offline. The hub has no checkpoint of this worktree.</span>
      )}
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
