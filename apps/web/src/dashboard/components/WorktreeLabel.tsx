import { cn } from "@band-app/ui";

/**
 * Two-row worktree label: the worktree name on the first line with the
 * repo name stacked beneath it. Shared by the Pinned section cards
 * (`WorktreeCard` with `showRepoName`), the mobile worktree header
 * (`MobileWorktreeShell`) and the ⌘K worktree picker
 * (`WorktreePickerDialog`) so both render the same compact, scannable block
 * instead of a long, mid-truncated `repo/name` string on one line.
 *
 * `isActive` bolds the name + brightens the repo line to mark the
 * currently-open worktree, matching the card's active styling.
 *
 * `tone` adapts the text colour to the surface:
 *  - "sidebar" (default): compact 13px/11px text at reduced foreground opacity,
 *    matching the surrounding cards in the dense repo tree.
 *  - "switcher": full-size, brighter text for the command-palette overlay.
 */
interface WorktreeLabelProps {
  /** Stable worktree identity/label (see `WorktreeInfo.name`). */
  name: string;
  repoName: string;
  isActive?: boolean;
  tone?: "sidebar" | "switcher";
}

export function WorktreeLabel({ name, repoName, isActive, tone = "sidebar" }: WorktreeLabelProps) {
  const nameClass =
    tone === "switcher"
      ? `text-foreground ${isActive ? "font-semibold" : "font-medium"}`
      : isActive
        ? "font-bold text-foreground"
        : "font-medium text-foreground/75";
  const repoClass =
    tone === "switcher"
      ? "text-foreground/70"
      : isActive
        ? "text-foreground/80"
        : "text-foreground/60";
  const isSidebar = tone === "sidebar";

  return (
    <div data-testid="worktree-label" className="flex flex-col min-w-0 leading-tight">
      <span
        data-testid="worktree-label__name"
        className={cn(isSidebar ? "text-[13px]" : "text-sm", "truncate", nameClass)}
      >
        {name}
      </span>
      <span
        data-testid="worktree-label__repo"
        className={cn(isSidebar ? "text-[11px]" : "text-xs", "truncate", repoClass)}
      >
        {repoName}
      </span>
    </div>
  );
}
