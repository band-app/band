/**
 * Renders the blocks the editable markdown preview shows rendered rather than
 * as text (tables, YAML frontmatter, mermaid fences) with the same Streamdown
 * setup the chat uses. Passed to `FileViewer` as `renderMarkdownBlock`; each
 * block gets its own small React root inside the CodeMirror widget.
 */

import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type { RenderMarkdownBlock } from "@/dashboard";
import { applyFrontmatterTable } from "../lib/frontmatter";
import { streamdownComponents, streamdownPlugins } from "./streamdown-components";

export const renderMarkdownBlock: RenderMarkdownBlock = ({ kind, source }, container) => {
  const markdown = kind === "frontmatter" ? applyFrontmatterTable(source) : source;
  const root = createRoot(container);
  root.render(
    <Streamdown
      className="size-full break-words leading-relaxed [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      plugins={streamdownPlugins}
      components={streamdownComponents}
    >
      {markdown}
    </Streamdown>,
  );
  // CodeMirror destroys widgets while it updates the view; unmounting React
  // synchronously from there can land inside a React render, so defer it.
  return () => queueMicrotask(() => root.unmount());
};
