import { useEffect, useState } from "react";
import { useAdapter } from "../context";
import type { WorkspaceDiff } from "../types";

interface DiffViewProps {
  workspaceId: string;
}

interface ParsedFile {
  filename: string;
  hunks: string;
}

function parseDiffFiles(diff: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  const fileDiffs = diff.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split("\n");
    // Extract filename from the first line: "a/path b/path"
    const firstLine = lines[0] || "";
    const match = firstLine.match(/b\/(.+)$/);
    const filename = match ? match[1] : firstLine;

    files.push({
      filename,
      hunks: `diff --git ${fileDiff}`,
    });
  }

  return files;
}

function DiffFileContent({ hunks }: { hunks: string }) {
  const lines = hunks.split("\n");
  const codeLines: { type: "add" | "del" | "context" | "hunk"; text: string }[] = [];

  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      codeLines.push({ type: "hunk", text: line });
    } else if (inHunk) {
      if (line.startsWith("+")) {
        codeLines.push({ type: "add", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        codeLines.push({ type: "del", text: line.slice(1) });
      } else if (line.startsWith(" ") || line === "") {
        codeLines.push({ type: "context", text: line.slice(1) || "" });
      }
    }
  }

  return (
    <div className="overflow-x-auto">
      <pre className="text-xs leading-5">
        {codeLines.map((line, i) => (
          <div
            key={`${line.type}-${i}`}
            className={
              line.type === "add"
                ? "bg-green-500/10 text-green-400"
                : line.type === "del"
                  ? "bg-red-500/10 text-red-400"
                  : line.type === "hunk"
                    ? "bg-blue-500/10 text-blue-400"
                    : "text-foreground/70"
            }
          >
            <span className="inline-block w-5 select-none text-center text-muted-foreground/50">
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function DiffView({ workspaceId }: DiffViewProps) {
  const adapter = useAdapter();
  const [data, setData] = useState<WorkspaceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!adapter.getWorkspaceDiff) {
      setError("Diff viewing not supported");
      setLoading(false);
      return;
    }

    let cancelled = false;
    adapter
      .getWorkspaceDiff(workspaceId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load diff");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, workspaceId]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading changes...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!data || !data.diff) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No changes
      </div>
    );
  }

  const files = parseDiffFiles(data.diff);

  const toggleFile = (filename: string) => {
    setOpenFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/50 px-4 py-3">
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{data.stats.filesChanged}</span>{" "}
          {data.stats.filesChanged === 1 ? "file" : "files"} changed
          {data.stats.insertions > 0 && (
            <span className="ml-2 text-green-400">+{data.stats.insertions}</span>
          )}
          {data.stats.deletions > 0 && (
            <span className="ml-1 text-red-400">-{data.stats.deletions}</span>
          )}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {data.baseBranch} ← {data.headBranch}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.map((file) => {
          const isOpen = openFiles.has(file.filename);
          return (
            <div key={file.filename} className="border-b border-border/30">
              <button
                type="button"
                onClick={() => toggleFile(file.filename)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs hover:bg-accent/50"
              >
                <span
                  className={`text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                >
                  ▶
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{file.filename}</span>
              </button>
              {isOpen && (
                <div className="border-t border-border/20 bg-muted/30 px-2 py-1">
                  <DiffFileContent hunks={file.hunks} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
