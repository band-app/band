import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc-client";

interface CommitFileChange {
  path: string;
  status: string;
}

interface CommitDetails {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  authorTs: number;
  committer: string;
  committerTs: number;
  subject: string;
  body: string;
  files: CommitFileChange[];
}

/** Colour + label for a git name-status code. */
function statusMeta(status: string): { label: string; className: string } {
  switch (status[0]) {
    case "A":
      return { label: "A", className: "text-emerald-600 dark:text-emerald-400" };
    case "M":
      return { label: "M", className: "text-amber-600 dark:text-amber-400" };
    case "D":
      return { label: "D", className: "text-red-600 dark:text-red-400" };
    case "R":
      return { label: "R", className: "text-sky-600 dark:text-sky-400" };
    case "C":
      return { label: "C", className: "text-sky-600 dark:text-sky-400" };
    default:
      return { label: status[0] ?? "?", className: "text-muted-foreground" };
  }
}

function formatFull(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Renders a unified git diff string with +/- line colouring. */
function UnifiedDiff({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        No textual diff (binary file or no changes).
      </div>
    );
  }
  const lines = diff.split("\n");
  return (
    <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-[1.5]">
      {lines.map((line, i) => {
        let cls = "text-foreground/80";
        if (line.startsWith("@@")) cls = "text-sky-600 dark:text-sky-400 bg-sky-500/5";
        else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git"))
          cls = "text-muted-foreground";
        else if (line.startsWith("+"))
          cls = "text-emerald-700 dark:text-emerald-300 bg-emerald-500/10";
        else if (line.startsWith("-")) cls = "text-red-700 dark:text-red-300 bg-red-500/10";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and static
          <div key={i} className={`whitespace-pre px-2 ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

interface CommitDetailsPanelProps {
  workspaceId: string;
  sha: string;
  onClose: () => void;
}

/** Bottom panel showing a selected commit's metadata, changed files, and the
 *  diff of whichever file is selected. */
export function CommitDetailsPanel({ workspaceId, sha, onClose }: CommitDetailsPanelProps) {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setError(null);
    setActiveFile(null);
    setFileDiff(null);
    trpc.workspace.getCommitDetails
      .query({ workspaceId, sha })
      .then((res) => {
        if (cancelled) return;
        setDetails(res);
        if (res.files.length > 0) setActiveFile(res.files[0].path);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, sha]);

  useEffect(() => {
    if (!activeFile) {
      setFileDiff(null);
      return;
    }
    let cancelled = false;
    setFileDiff(null);
    trpc.workspace.getCommitFileDiff
      .query({ workspaceId, sha, filePath: activeFile })
      .then((res) => {
        if (!cancelled) setFileDiff(res.diff);
      })
      .catch(() => {
        if (!cancelled) setFileDiff("");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, sha, activeFile]);

  return (
    <div
      className="flex min-h-0 shrink-0 flex-col border-t border-border bg-background"
      style={{ height: "45%" }}
      data-testid="git-graph__commit-details"
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{details?.subject ?? "Loading…"}</div>
          {details && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>
                {details.author} &lt;{details.email}&gt;
              </span>
              <span>{formatFull(details.committerTs)}</span>
              <span className="font-mono">{details.sha.slice(0, 10)}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close commit details"
        >
          <X className="size-4" />
        </button>
      </div>

      {error ? (
        <div className="p-4 text-sm text-destructive">Failed to load commit: {error}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-64 shrink-0 flex-col overflow-auto border-r border-border/60">
            {details?.body && (
              <div className="whitespace-pre-wrap border-b border-border/40 p-2 text-xs text-muted-foreground">
                {details.body}
              </div>
            )}
            {details?.files.map((f) => {
              const meta = statusMeta(f.status);
              const isActive = activeFile === f.path;
              return (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => setActiveFile(f.path)}
                  title={f.path}
                  className={`flex items-center gap-2 px-2 py-1 text-left text-xs transition-colors ${
                    isActive ? "bg-accent text-foreground" : "hover:bg-accent/40"
                  }`}
                >
                  <span className={`w-3 shrink-0 font-mono font-semibold ${meta.className}`}>
                    {meta.label}
                  </span>
                  <span className="truncate" dir="rtl">
                    {f.path}
                  </span>
                </button>
              );
            })}
            {details && details.files.length === 0 && (
              <div className="p-2 text-xs text-muted-foreground">No file changes.</div>
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-auto">
            {fileDiff == null ? (
              <div className="p-4 text-xs text-muted-foreground">Loading diff…</div>
            ) : (
              <UnifiedDiff diff={fileDiff} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
