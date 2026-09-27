/**
 * Renders the blocks the editable markdown preview shows rendered rather than
 * as text (mermaid fences) with the same Streamdown setup the chat uses.
 * Tables and frontmatter are editable grids in the preview itself
 * (`markdown-table-widget.ts`). Passed to `FileViewer` as
 * `renderMarkdownBlock`; each block gets its own small React root inside the
 * CodeMirror widget.
 */

import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type { RenderMarkdownBlock } from "@/dashboard";
import { streamdownComponents, streamdownPlugins } from "./streamdown-components";

export const renderMarkdownBlock: RenderMarkdownBlock = ({ source }, container) => {
  const root = createRoot(container);
  root.render(
    <Streamdown
      className="size-full break-words leading-relaxed [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      plugins={streamdownPlugins}
      components={streamdownComponents}
    >
      {source}
    </Streamdown>,
  );
  // CodeMirror destroys widgets while it updates the view; unmounting React
  // synchronously from there can land inside a React render, so defer it.
  return () => queueMicrotask(() => root.unmount());
};
