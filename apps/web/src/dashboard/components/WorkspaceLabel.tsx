import { cn } from "@band-app/ui";

/**
 * Two-row workspace label: the workspace name on the first line with the
 * project name stacked beneath it. Shared by the Pinned section cards
 * (`WorkspaceCard` with `showProjectName`) and the ⌘K workspace picker
 * (`WorkspacePickerDialog`) so both render the same compact, scannable block
 * instead of a long, mid-truncated `project/name` string on one line.
 *
 * `isActive` bolds the name + brightens the project line to mark the
 * currently-open workspace, matching the card's active styling.
 *
 * `tone` adapts the text colour to the surface:
 *  - "sidebar" (default): muted text so the label sits quietly inside the dense
 *    project tree, matching the surrounding cards.
 *  - "switcher": brighter text for the command-palette overlay, where muted
 *    grey-on-dark is hard to read.
 */
interface WorkspaceLabelProps {
  /** Stable workspace identity/label (see `WorktreeInfo.name`). */
  name: string;
  projectName: string;
  isActive?: boolean;
  tone?: "sidebar" | "switcher";
}

export function WorkspaceLabel({
  name,
  projectName,
  isActive,
  tone = "sidebar",
}: WorkspaceLabelProps) {
  const nameClass =
    tone === "switcher"
      ? `text-foreground ${isActive ? "font-semibold" : "font-medium"}`
      : isActive
        ? "font-bold text-foreground"
        : "font-medium text-muted-foreground";
  const projectClass =
    tone === "switcher"
      ? "text-foreground/70"
      : isActive
        ? "text-foreground/80"
        : "text-muted-foreground";

  return (
    <div className="flex flex-col min-w-0 leading-tight">
      <span className={cn("text-sm truncate", nameClass)}>{name}</span>
      <span className={cn("text-xs truncate", projectClass)}>{projectName}</span>
    </div>
  );
}
