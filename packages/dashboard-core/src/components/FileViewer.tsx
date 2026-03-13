import { ArrowLeft, FileWarning } from "lucide-react";
import { useEffect, useState } from "react";
import { useAdapter } from "../context";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import type { FileContentResult } from "../types";

interface FileViewerProps {
  workspaceId: string;
  filePath: string;
  onBack?: () => void;
}

interface TokenSpan {
  content: string;
  color?: string;
}

type TokenLine = TokenSpan[];

let highlighterPromise: Promise<typeof import("shiki")> | null = null;

function getShiki() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki");
  }
  return highlighterPromise;
}

function getFilename(path: string): string {
  return path.split("/").pop() || path;
}

function getExtension(path: string): string {
  const name = getFilename(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function detectLanguage(filePath: string, serverHint?: string): string {
  if (serverHint) return serverHint;
  const ext = getExtension(filePath);
  const fromExt = extensionToLanguage(ext);
  if (fromExt) return fromExt;
  const fromName = filenameToLanguage(getFilename(filePath));
  return fromName || "plaintext";
}

export function FileViewer({ workspaceId, filePath, onBack }: FileViewerProps) {
  const adapter = useAdapter();
  const [data, setData] = useState<FileContentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightedLines, setHighlightedLines] = useState<TokenLine[] | null>(null);

  useEffect(() => {
    if (!adapter.getWorkspaceFile) {
      setError("File viewing not supported");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setHighlightedLines(null);

    adapter
      .getWorkspaceFile(workspaceId, filePath)
      .then(async (result) => {
        if (cancelled) return;
        setData(result);

        if (result.content) {
          try {
            const lang = detectLanguage(filePath, result.language);
            const shiki = await getShiki();
            const result2 = await shiki.codeToTokens(result.content, {
              lang: lang as never,
              theme: "github-dark",
            });
            if (!cancelled) {
              setHighlightedLines(
                result2.tokens.map((line) =>
                  line.map((t) => ({ content: t.content, color: t.color })),
                ),
              );
            }
          } catch {
            // Fall back to plain text rendering
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to read file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, workspaceId, filePath]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex size-7 items-center justify-center rounded-md hover:bg-accent"
          >
            <ArrowLeft className="size-3.5" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{filePath}</span>
        {data && (
          <span className="shrink-0 text-xs text-muted-foreground">{formatSize(data.size)}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Loading...
          </div>
        )}
        {error && (
          <div className="flex h-32 items-center justify-center text-sm text-destructive">
            {error}
          </div>
        )}
        {data?.binary && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="size-8" />
            Binary file ({formatSize(data.size)})
          </div>
        )}
        {data?.tooLarge && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="size-8" />
            File too large ({formatSize(data.size)})
          </div>
        )}
        {data?.content && highlightedLines && <HighlightedCode lines={highlightedLines} />}
        {data?.content && !highlightedLines && !loading && <PlainCode content={data.content} />}
      </div>
    </div>
  );
}

function lineNumberWidth(totalLines: number): string {
  const digits = String(totalLines).length;
  const ch = Math.max(3, digits);
  return `${ch}ch`;
}

function HighlightedCode({ lines }: { lines: TokenLine[] }) {
  const gutterWidth = lineNumberWidth(lines.length);
  return (
    <div className="overflow-x-auto p-2">
      <pre className="text-xs leading-5">
        {lines.map((tokens, lineIdx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: code lines have no stable id
          <div key={lineIdx} className="flex gap-4">
            <span
              className="shrink-0 select-none text-right text-muted-foreground"
              style={{ width: gutterWidth }}
            >
              {lineIdx + 1}
            </span>
            <span className="flex-1">
              {tokens.map((token, tIdx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no stable id
                <span key={tIdx} style={token.color ? { color: token.color } : undefined}>
                  {token.content}
                </span>
              ))}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function PlainCode({ content }: { content: string }) {
  const lines = content.split("\n");
  const gutterWidth = lineNumberWidth(lines.length);
  return (
    <div className="overflow-x-auto p-2">
      <pre className="text-xs leading-5">
        {lines.map((line, lineIdx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: code lines have no stable id
          <div key={lineIdx} className="flex gap-4">
            <span
              className="shrink-0 select-none text-right text-muted-foreground"
              style={{ width: gutterWidth }}
            >
              {lineIdx + 1}
            </span>
            <span className="flex-1">{line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
