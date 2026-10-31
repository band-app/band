import { cn } from "@band-app/ui";
import { Download, Expand, FileIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo, useCallback, useMemo, useState } from "react";
import remarkBreaks from "remark-breaks";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import { hubAssetUrl } from "../../lib/hub-config";
import { parseSharedFileUrl, sharedFilePath } from "../../lib/shared-file";
import { useDirectAssetUrl } from "../../lib/use-direct-asset-url";
import { streamdownPlugins } from "../streamdown-components";
import { getWorktreeLeafActions } from "../WorktreeCenter";
import {
  fileLinkComponents,
  fileLinkRehypePlugins,
  fileLinkRemarkPlugins,
  fileLinkUrlTransform,
} from "./file-link-components";
import { FilePreviewOverlay } from "./file-preview-overlay";
import { downloadFile, isTextMediaType } from "./file-preview-utils";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant";
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    // Default role-scoped testid lets integration tests target real
    // message bubbles. Callers that wrap `Message` in a skeleton
    // placeholder (see `ConversationSkeleton`) override it with
    // `data-testid={undefined}` so locators don't pick up loading
    // states. Spread-after-default means an explicit `data-testid` in
    // `props` always wins.
    data-testid={from === "user" ? "chat-pane__user-message" : "chat-pane__assistant-message"}
    className={cn(
      "group flex w-full min-w-0 flex-col gap-2",
      from === "user" ? "is-user ml-auto max-w-[90%] justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "flex min-w-0 max-w-full flex-col gap-px break-words [overflow-wrap:anywhere] text-base lg:text-sm group-[.is-assistant]:gap-2",
      "group-[.is-assistant]:w-full group-[.is-user]:w-fit",
      "group-[.is-user]:ml-auto group-[.is-user]:overflow-hidden group-[.is-user]:rounded-md group-[.is-user]:border-2 group-[.is-user]:border-border group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full break-words leading-relaxed [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      plugins={streamdownPlugins}
      components={fileLinkComponents}
      remarkPlugins={[
        ...Object.values(defaultRemarkPlugins),
        remarkBreaks,
        ...fileLinkRemarkPlugins,
      ]}
      rehypePlugins={[...Object.values(defaultRehypePlugins), ...fileLinkRehypePlugins]}
      urlTransform={fileLinkUrlTransform}
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
  const shared = useMemo(() => parseSharedFileUrl(part.url), [part.url]);
  const imageUrl = useDirectAssetUrl(isImage ? hubAssetUrl(part.url) : undefined);

  // A file an agent shared opens in a center tab; anything else previews in an overlay.
  const openInTab = useCallback(() => {
    if (!shared) return false;
    const actions = getWorktreeLeafActions(shared.worktreeId);
    if (!actions) return false;
    actions.openFile(sharedFilePath(shared.chatId, shared.name), { preview: false });
    return true;
  }, [shared]);

  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      downloadFile(hubAssetUrl(part.url), filename);
    },
    [part.url, filename],
  );

  if (isImage) {
    return (
      <div className="relative w-fit max-w-xs" data-testid="message__file-card">
        <button
          type="button"
          data-testid="message__image-preview-button"
          onClick={() => {
            if (!openInTab()) setOverlayOpen(true);
          }}
          className="group/img relative max-w-xs cursor-pointer overflow-hidden rounded-md"
        >
          <img
            src={imageUrl}
            alt={filename}
            className="rounded-md transition-opacity group-hover/img:opacity-90"
          />
          {/* theme-lint-ignore-line: image hover tint stays black whatever the theme */}
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/img:bg-black/20">
            {/* theme-lint-ignore-line: white icon over the dark hover tint */}
            <Expand className="size-6 text-white opacity-0 drop-shadow-md transition-opacity group-hover/img:opacity-100" />
          </div>
        </button>
        <button
          type="button"
          aria-label="Download file"
          data-testid="message__file-card-download"
          onClick={handleDownload}
          className="absolute right-1.5 top-1.5 rounded bg-background/80 p-1 text-muted-foreground hover:text-foreground"
        >
          <Download className="size-3.5" />
        </button>
        <FilePreviewOverlay open={overlayOpen} onOpenChange={setOverlayOpen} part={part} />
      </div>
    );
  }

  return (
    <>
      <div
        data-testid="message__file-card"
        className={cn(
          "flex max-w-sm items-center gap-2 rounded-md border border-border/30 bg-muted/30 transition-colors",
          (canPreview || shared) && "hover:bg-muted/50",
        )}
      >
        <button
          type="button"
          data-testid="message__file-card-open"
          onClick={() => {
            if (openInTab()) return;
            if (canPreview) setOverlayOpen(true);
          }}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 text-left",
            (canPreview || shared) && "cursor-pointer",
          )}
        >
          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-base">{filename}</span>
          <span className="shrink-0 text-sm text-muted-foreground">{part.mediaType}</span>
        </button>
        <button
          type="button"
          aria-label="Download file"
          data-testid="message__file-card-download"
          onClick={handleDownload}
          className="mr-2 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Download className="size-3.5" />
        </button>
      </div>
      {canPreview && (
        <FilePreviewOverlay open={overlayOpen} onOpenChange={setOverlayOpen} part={part} />
      )}
    </>
  );
}
