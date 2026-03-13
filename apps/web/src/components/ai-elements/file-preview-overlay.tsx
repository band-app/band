import { cn } from "@band/ui";
import { Download, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { detectLanguageFromFilename, downloadFile, isTextMediaType } from "./file-preview-utils";
import { useSyntaxHighlight, type TokenLine } from "./use-syntax-highlight";

interface FilePreviewOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  part: {
    mediaType: string;
    url: string;
    filename?: string;
  };
}

export function FilePreviewOverlay({ open, onOpenChange, part }: FilePreviewOverlayProps) {
  const isImage = part.mediaType.startsWith("image/");
  const isText = isTextMediaType(part.mediaType);
  const filename = part.filename ?? "file";

  const handleDownload = useCallback(() => {
    downloadFile(part.url, filename);
  }, [part.url, filename]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/80 backdrop-blur-sm",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-0 z-50 flex flex-col outline-none",
            "h-[100dvh] w-screen",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
          aria-describedby={undefined}
        >
          {/* Accessible title (hidden) */}
          <DialogPrimitive.Title className="sr-only">{filename}</DialogPrimitive.Title>

          {/* Top bar */}
          <div className="flex shrink-0 items-center justify-between px-4 py-3">
            <span className="min-w-0 truncate font-mono text-sm text-white/90">{filename}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleDownload}
                className="inline-flex size-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Download file"
              >
                <Download className="size-4" />
              </button>
              <DialogPrimitive.Close
                className="inline-flex size-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Close preview"
              >
                <X className="size-4" />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* Content area */}
          <div className="min-h-0 flex-1 overflow-auto">
            {isImage && <ImagePreview url={part.url} alt={filename} />}
            {isText && <TextPreview url={part.url} filename={filename} />}
            {!isImage && !isText && (
              <div className="flex h-full items-center justify-center text-white/50">
                <p>Preview not available for this file type</p>
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ImagePreview({ url, alt }: { url: string; alt: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <img src={url} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

function TextPreview({ url, filename }: { url: string; filename: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const language = detectLanguageFromFilename(filename);
  const { lines } = useSyntaxHighlight(content, language);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => res.text())
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-white/50">
        Failed to load file content
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-white/50">Loading…</div>
    );
  }

  if (lines) {
    return <HighlightedCode lines={lines} />;
  }

  return <PlainCode content={content} />;
}

function lineNumberWidth(totalLines: number): string {
  const digits = String(totalLines).length;
  return `${Math.max(2, digits)}ch`;
}

function HighlightedCode({ lines }: { lines: TokenLine[] }) {
  const gutterWidth = lineNumberWidth(lines.length);
  return (
    <div className="overflow-x-auto p-4">
      <pre className="text-xs leading-5">
        {lines.map((tokens, lineIdx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: code lines have no stable id
          <div key={lineIdx} className="flex">
            <span
              className="shrink-0 select-none pr-4 text-right text-white/25"
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
    <div className="overflow-x-auto p-4">
      <pre className="text-xs leading-5 text-white/80">
        {lines.map((line, lineIdx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: code lines have no stable id
          <div key={lineIdx} className="flex">
            <span
              className="shrink-0 select-none pr-4 text-right text-white/25"
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
