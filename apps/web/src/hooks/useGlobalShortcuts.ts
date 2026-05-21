import type { PlatformCapabilities } from "@band-app/dashboard-core";
import { useHotkeys } from "react-hotkeys-hook";
import { getDockviewApi } from "../lib/dockview-instance";
import { useRecentWorkspaces } from "./useRecentWorkspaces";

type Direction = 1 | -1;

function cycleTabsInActiveGroup(direction: Direction): void {
  const api = getDockviewApi();
  if (!api) return;
  const group = api.activeGroup;
  if (!group) return;
  const panels = group.panels;
  if (panels.length < 2) return;
  const activeId = group.activePanel?.id;
  const idx = activeId ? panels.findIndex((p) => p.id === activeId) : 0;
  const next = panels[(idx + direction + panels.length) % panels.length];
  next?.api.setActive();
}

function cycleGridGroups(direction: Direction): void {
  const api = getDockviewApi();
  if (!api) return;
  const groups = api.groups.filter((g) => g.api.location.type === "grid");
  if (groups.length < 2) return;
  const current = api.activeGroup;
  const idx = current ? groups.findIndex((g) => g.id === current.id) : -1;
  const next = groups[(idx + direction + groups.length) % groups.length];
  next?.activePanel?.api.setActive();
}

interface UseGlobalShortcutsArgs {
  routerNavigate: (href: string) => void;
  capabilities: PlatformCapabilities;
}

/**
 * Global keyboard shortcuts wired via react-hotkeys-hook.
 *
 * Mod = Cmd on macOS, Ctrl elsewhere. The library handles platform detection
 * via the `mod` key alias.
 *
 * Shortcuts:
 *   - mod+[          → previous tab in active panel group
 *   - mod+]          → next tab in active panel group
 *   - mod+shift+[    → focus previous panel group (grid only)
 *   - mod+shift+]    → focus next panel group (grid only)
 *   - ctrl+tab       → toggle to previously-visited workspace
 */
export function useGlobalShortcuts({ routerNavigate, capabilities }: UseGlobalShortcutsArgs): void {
  const recent = useRecentWorkspaces();

  useHotkeys("mod+[", () => cycleTabsInActiveGroup(-1), {
    preventDefault: true,
    enableOnFormTags: true,
    enableOnContentEditable: true,
  });

  useHotkeys("mod+]", () => cycleTabsInActiveGroup(1), {
    preventDefault: true,
    enableOnFormTags: true,
    enableOnContentEditable: true,
  });

  useHotkeys("mod+shift+[", () => cycleGridGroups(-1), {
    preventDefault: true,
    enableOnFormTags: true,
    enableOnContentEditable: true,
  });

  useHotkeys("mod+shift+]", () => cycleGridGroups(1), {
    preventDefault: true,
    enableOnFormTags: true,
    enableOnContentEditable: true,
  });

  useHotkeys(
    "ctrl+tab",
    () => {
      const prev = recent.getPrevious();
      if (!prev) return;
      const href = capabilities.getWorkspaceHref?.(prev);
      if (href) routerNavigate(href);
    },
    { preventDefault: true, enableOnFormTags: true, enableOnContentEditable: true },
  );
}
