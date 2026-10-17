import { cn } from "@band-app/ui";
import type { AnchorHTMLAttributes, ImgHTMLAttributes } from "react";
import { Streamdown } from "streamdown";

import { streamdownComponents, streamdownPlugins } from "../components/streamdown-components";

const SharedLink = streamdownComponents.a;

function isWebUrl(href: string | undefined): boolean {
  if (!href) return false;
  try {
    const protocol = new URL(href).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** A comment's link opens only when it is http(s). Any other scheme renders as plain text. */
function SafeLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  if (!isWebUrl(props.href)) return <span>{props.children}</span>;
  return <SharedLink {...props} />;
}

/** A comment's image would load a third-party URL when the panel opens, so show its alt text instead. */
function AltOnlyImage({ alt }: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  return alt ? <span>{alt}</span> : null;
}

const pluginComponents = { ...streamdownComponents, a: SafeLink, img: AltOnlyImage };

/** Markdown for plugin UI. Streamdown sanitises the tree, links are limited to http(s) and images are not loaded. */
export function PluginMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <Streamdown
      className={cn(
        "break-words text-[13px] leading-relaxed [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      plugins={streamdownPlugins}
      components={pluginComponents}
    >
      {children}
    </Streamdown>
  );
}
