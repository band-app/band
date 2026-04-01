import { cn } from "@band-app/ui";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import { Download, Expand, FileIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo, useCallback, useState } from "react";
import { Streamdown } from "streamdown";

import { FilePreviewOverlay } from "./file-preview-overlay";
import { downloadFile, isTextMediaType } from "./file-preview-utils";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full min-w-0 max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "flex min-w-0 max-w-full flex-col gap-px break-words [overflow-wrap:anywhere] text-base lg:text-sm",
      "group-[.is-assistant]:w-full group-[.is-user]:w-fit",
      "group-[.is-user]:ml-auto group-[.is-user]:overflow-hidden group-[.is-user]:rounded-md group-[.is-user]:border-2 group-[.is-user]:border-white/20 group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, code, math, mermaid };

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full break-words [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = "MessageResponse";

interface FilePartData {
  type: "file";
  mediaType: string;
  url: string;
  filename?: string;
}

export function MessageFilePart({ part }: { part: FilePartData }) {
  const [overlayOpen, setOverlayOpen] = useState(false);
  const isImage = part.mediaType.startsWith("image/");
  const isText = isTextMediaType(part.mediaType);
  const canPreview = isImage || isText;
  const filename = part.filename ?? "File";

  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      downloadFile(part.url, filename);
    },
    [part.url, filename],
  );

  if (isImage) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOverlayOpen(true)}
          className="group/img relative max-w-xs cursor-pointer overflow-hidden rounded-md"
        >
          <img
            src={part.url}
            alt={filename}
            className="rounded-md transition-opacity group-hover/img:opacity-90"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/img:bg-black/20">
            <Expand className="size-6 text-white opacity-0 drop-shadow-md transition-opacity group-hover/img:opacity-100" />
          </div>
        </button>
        <FilePreviewOverlay open={overlayOpen} onOpenChange={setOverlayOpen} part={part} />
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => canPreview && setOverlayOpen(true)}
        className={cn(
          "flex max-w-sm items-center gap-2 rounded-md border border-border/30 bg-muted/30 px-3 py-2 transition-colors",
          canPreview && "cursor-pointer hover:bg-muted/50",
        )}
      >
        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left text-base">{filename}</span>
        <span className="shrink-0 text-sm text-muted-foreground">{part.mediaType}</span>
        <button
          type="button"
          onClick={handleDownload}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Download className="size-3.5" />
        </button>
      </button>
      {canPreview && (
        <FilePreviewOverlay open={overlayOpen} onOpenChange={setOverlayOpen} part={part} />
      )}
    </>
  );
}
