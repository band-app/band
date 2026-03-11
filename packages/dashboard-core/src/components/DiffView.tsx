import { useEffect, useState } from "react";
import { useAdapter } from "../context";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import type { FileStatus, WorkspaceDiff } from "../types";

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
    const match = firstLine.match(/ b\/(.+)$/);
    const filename = match ? match[1] : firstLine;

    files.push({
      filename,
      hunks: `diff --git ${fileDiff}`,
    });
  }

  return files;
}

const statusColors: Record<FileStatus, string> = {
  A: "text-green-400",
  M: "text-blue-400",
  D: "text-red-400",
  R: "text-purple-400",
  U: "text-yellow-400",
};

function FileStatusBadge({ status }: { status: FileStatus | undefined }) {
  if (!status) return null;
  return <span className={`shrink-0 text-xs font-bold ${statusColors[status]}`}>{status}</span>;
}

// Lazy Shiki loading
let shikiPromise: Promise<typeof import("shiki")> | null = null;
function getShiki() {
  if (!shikiPromise) {
    shikiPromise = import("shiki");
  }
  return shikiPromise;
}

function detectLanguage(filePath: string): string {
  const name = filePath.split("/").pop() || filePath;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return extensionToLanguage(ext) || filenameToLanguage(name) || "plaintext";
}

interface DiffLine {
  type: "add" | "del" | "context" | "hunk";
  text: string;
}

interface TokenSpan {
  content: string;
  color?: string;
}

type HighlightedLine = { type: DiffLine["type"]; tokens: TokenSpan[] };

function parseDiffLines(hunks: string): DiffLine[] {
  const lines = hunks.split("\n");
  const result: DiffLine[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      result.push({ type: "hunk", text: line });
    } else if (inHunk) {
      if (line.startsWith("+")) {
        result.push({ type: "add", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        result.push({ type: "del", text: line.slice(1) });
      } else if (line.startsWith(" ") || line === "") {
        result.push({ type: "context", text: line.slice(1) || "" });
      }
    }
  }
  return result;
}

async function highlightDiffLines(diffLines: DiffLine[], lang: string): Promise<HighlightedLine[]> {
  const shiki = await getShiki();

  // Build separate old (context+del) and new (context+add) versions
  // so each is valid code for the highlighter.
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const mapping: { type: DiffLine["type"]; source: "old" | "new"; idx: number }[] = [];

  for (const line of diffLines) {
    if (line.type === "context") {
      mapping.push({ type: "context", source: "new", idx: newLines.length });
      oldLines.push(line.text);
      newLines.push(line.text);
    } else if (line.type === "add") {
      mapping.push({ type: "add", source: "new", idx: newLines.length });
      newLines.push(line.text);
    } else if (line.type === "del") {
      mapping.push({ type: "del", source: "old", idx: oldLines.length });
      oldLines.push(line.text);
    } else {
      mapping.push({ type: "hunk", source: "new", idx: -1 });
    }
  }

  type TokenLine = TokenSpan[];
  let oldTokenLines: TokenLine[] = [];
  let newTokenLines: TokenLine[] = [];

  try {
    const [oldResult, newResult] = await Promise.all([
      oldLines.length > 0
        ? shiki.codeToTokens(oldLines.join("\n"), { lang: lang as never, theme: "github-dark" })
        : null,
      newLines.length > 0
        ? shiki.codeToTokens(newLines.join("\n"), { lang: lang as never, theme: "github-dark" })
        : null,
    ]);
    if (oldResult) {
      oldTokenLines = oldResult.tokens.map((line) =>
        line.map((t) => ({ content: t.content, color: t.color })),
      );
    }
    if (newResult) {
      newTokenLines = newResult.tokens.map((line) =>
        line.map((t) => ({ content: t.content, color: t.color })),
      );
    }
  } catch {
    // Fallback: no syntax colors
    return diffLines.map((line) => ({ type: line.type, tokens: [{ content: line.text }] }));
  }

  return mapping.map((m, i) => {
    if (m.type === "hunk") {
      return { type: "hunk" as const, tokens: [{ content: diffLines[i].text }] };
    }
    const tokenLine = m.source === "old" ? oldTokenLines[m.idx] : newTokenLines[m.idx];
    return {
      type: m.type,
      tokens: tokenLine ?? [{ content: diffLines[i].text }],
    };
  });
}

function DiffFileContent({ hunks, filename }: { hunks: string; filename: string }) {
  const [highlighted, setHighlighted] = useState<HighlightedLine[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const diffLines = parseDiffLines(hunks);
    const lang = detectLanguage(filename);
    highlightDiffLines(diffLines, lang).then((result) => {
      if (!cancelled) setHighlighted(result);
    });
    return () => {
      cancelled = true;
    };
  }, [hunks, filename]);

  // Render plain diff while highlighting loads
  const diffLines = parseDiffLines(hunks);
  const lines: HighlightedLine[] =
    highlighted ?? diffLines.map((l) => ({ type: l.type, tokens: [{ content: l.text }] }));

  return (
    <div className="overflow-x-auto">
      <pre className="text-xs leading-5">
        {lines.map((line, lineIdx) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable id
            key={lineIdx}
            className={
              line.type === "add"
                ? "bg-green-500/10"
                : line.type === "del"
                  ? "bg-red-500/10"
                  : line.type === "hunk"
                    ? "bg-blue-500/10 text-blue-400"
                    : ""
            }
          >
            <span className="inline-block w-5 select-none text-center text-muted-foreground/50">
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            {line.type === "hunk"
              ? line.tokens[0]?.content
              : line.tokens.map((token, tIdx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no stable id
                  <span key={tIdx} style={token.color ? { color: token.color } : undefined}>
                    {token.content}
                  </span>
                ))}
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
  const fileStatuses = data.fileStatuses || {};

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
        <div className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{data.stats.filesChanged}</span>{" "}
          {data.stats.filesChanged === 1 ? "file" : "files"} changed
          {data.stats.insertions > 0 && (
            <span className="ml-2 text-green-400">+{data.stats.insertions}</span>
          )}
          {data.stats.deletions > 0 && (
            <span className="ml-1 text-red-400">-{data.stats.deletions}</span>
          )}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
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
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-accent/50"
              >
                <span
                  className={`text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                >
                  ▶
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {file.filename} <FileStatusBadge status={fileStatuses[file.filename]} />
                </span>
              </button>
              {isOpen && (
                <div className="border-t border-border/20 bg-muted/30 px-2 py-1">
                  <DiffFileContent hunks={file.hunks} filename={file.filename} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
