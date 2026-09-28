import { FoldHorizontal, UnfoldHorizontal } from "lucide-react";
import { useMarkdownPreviewWidth } from "../dashboard/lib/markdown-preview-width";
import { useIsDesktop } from "../hooks/useIsDesktop";

/**
 * Switches every markdown preview between the centered column and the full
 * pane. Hidden below the desktop breakpoint, where the column already spans
 * the screen.
 */
export function MarkdownWidthToggle() {
  const isDesktop = useIsDesktop();
  const [width, setWidth] = useMarkdownPreviewWidth();
  if (!isDesktop) return null;
  const full = width === "full";
  return (
    <button
      type="button"
      onClick={() => setWidth(full ? "narrow" : "full")}
      title={full ? "Narrow width" : "Full width"}
      aria-label="Full width"
      aria-pressed={full}
      data-testid="center-file-leaf__width-toggle"
      className={`inline-flex size-7 items-center justify-center rounded transition-colors hover:bg-accent ${
        full ? "bg-accent text-foreground" : "text-muted-foreground"
      }`}
    >
      {full ? <FoldHorizontal className="size-3.5" /> : <UnfoldHorizontal className="size-3.5" />}
    </button>
  );
}
