import { cn } from "@band/ui";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import { FileIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
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
      "is-user:dark flex min-w-0 max-w-full flex-col gap-2 break-words text-base",
      "group-[.is-assistant]:w-full group-[.is-user]:w-fit",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-md group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
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
  const isImage = part.mediaType.startsWith("image/");

  if (isImage) {
    return (
      <img src={part.url} alt={part.filename ?? "Uploaded image"} className="max-w-xs rounded-md" />
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/30 px-3 py-2">
      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate text-base">{part.filename ?? "File"}</span>
      <span className="text-sm text-muted-foreground">{part.mediaType}</span>
    </div>
  );
}
