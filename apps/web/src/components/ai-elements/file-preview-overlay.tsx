import { CodeMirrorViewer } from "@band-app/dashboard-core";
import { cn } from "@band-app/ui";
import { Download, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useCallback, useEffect, useState } from "react";

import { detectLanguageFromFilename, downloadFile, isTextMediaType } from "./file-preview-utils";

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
          <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
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
          <div className="min-h-0 flex-1 overflow-hidden">
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

  return <CodeMirrorViewer content={content} language={language} className="h-full" />;
}
