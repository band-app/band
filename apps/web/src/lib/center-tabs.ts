/**
 * The center dockview's tab list, shared by every device through client
 * state (`band:center-tabs:<ws>`, scope `all`).
 *
 * Only which tabs are open, their order and the active tab are shared. Split
 * sizes and groups stay in each device type's own layout
 * (`band:dockview-layout-v9:<ws>`). Each device applies the shared list with
 * its own rules: mobile keeps one tab strip, and only the desktop app shows
 * browser tabs. A device keeps the entries it doesn't show when it writes the
 * list, so the phone never drops the desktop's browser tabs.
 */

import type { DockviewApi } from "dockview";
import { CENTER_TABS_PREFIX } from "../shared/client-state-keys";
import { clientStorage } from "./client-state";

export type CenterTabKind = "chat" | "term" | "browser" | "file" | "diff";

export interface CenterTab {
  id: string;
  kind: CenterTabKind;
}

export interface CenterTabs {
  tabs: CenterTab[];
  active: string | null;
}

const KINDS = new Set<string>(["chat", "term", "browser", "file", "diff"]);

export function centerTabsKey(workspaceId: string): string {
  return `${CENTER_TABS_PREFIX}${workspaceId}`;
}

export function parseCenterTabs(value: unknown): CenterTabs | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { tabs?: unknown; active?: unknown };
  if (!Array.isArray(v.tabs)) return null;
  const tabs: CenterTab[] = [];
  for (const t of v.tabs) {
    if (t && typeof t === "object" && typeof t.id === "string" && KINDS.has(t.kind)) {
      tabs.push({ id: t.id, kind: t.kind });
    }
  }
  return { tabs, active: typeof v.active === "string" ? v.active : null };
}

export function readCenterTabs(workspaceId: string): CenterTabs | null {
  const raw = clientStorage.getItem(centerTabsKey(workspaceId));
  if (!raw) return null;
  try {
    return parseCenterTabs(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The dockview's top-level tabs, group by group, left to right. */
export function centerTabsFromApi(api: DockviewApi): CenterTabs {
  const tabs: CenterTab[] = [];
  for (const group of api.groups) {
    if (group.api.location.type !== "grid") continue;
    for (const panel of group.panels) {
      const kind = panel.api.component;
      if (KINDS.has(kind)) tabs.push({ id: panel.id, kind: kind as CenterTabKind });
    }
  }
  return { tabs, active: api.activePanel?.id ?? null };
}

/**
 * Put back the entries of `previous` this device doesn't show (`shown`
 * returns false), each after the entry it followed before.
 */
export function keepHiddenTabs(
  next: CenterTabs,
  previous: CenterTabs | null,
  shown: (tab: CenterTab) => boolean,
): CenterTabs {
  if (!previous) return next;
  const tabs = [...next.tabs];
  let active = next.active;
  previous.tabs.forEach((tab, i) => {
    if (shown(tab) || tabs.some((t) => t.id === tab.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = tabs.findIndex((t) => t.id === previous.tabs[j].id);
      if (idx !== -1) {
        at = idx + 1;
        break;
      }
    }
    tabs.splice(at, 0, tab);
    if (previous.active === tab.id && active === null) active = tab.id;
  });
  return { tabs, active };
}

/**
 * The shared list with this device's opened and closed tabs applied, keeping
 * the shared order and active tab. A shared tab this device shows but doesn't
 * have was closed here; a local tab the list lacks goes after the local tab
 * it follows.
 */
export function withLocalMembership(
  shared: CenterTabs,
  local: CenterTabs,
  shown: (tab: CenterTab) => boolean,
): CenterTabs {
  const localIds = new Set(local.tabs.map((t) => t.id));
  const tabs = shared.tabs.filter((t) => localIds.has(t.id) || !shown(t));
  local.tabs.forEach((tab, i) => {
    if (tabs.some((t) => t.id === tab.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = tabs.findIndex((t) => t.id === local.tabs[j].id);
      if (idx !== -1) {
        at = idx + 1;
        break;
      }
    }
    tabs.splice(at, 0, tab);
  });
  const active =
    shared.active && tabs.some((t) => t.id === shared.active) ? shared.active : local.active;
  return { tabs, active };
}

export function writeCenterTabs(workspaceId: string, next: CenterTabs): void {
  const key = centerTabsKey(workspaceId);
  const raw = JSON.stringify(next);
  if (clientStorage.getItem(key) === raw) return;
  clientStorage.setItem(key, raw);
}

/** Tabs in `next` but not `prev`, and tabs in `prev` but not `next`. */
export function diffCenterTabs(
  prev: CenterTabs | null,
  next: CenterTabs | null,
): { added: CenterTab[]; removed: CenterTab[] } {
  const prevIds = new Set(prev?.tabs.map((t) => t.id));
  const nextIds = new Set(next?.tabs.map((t) => t.id));
  return {
    added: (next?.tabs ?? []).filter((t) => !prevIds.has(t.id)),
    removed: (prev?.tabs ?? []).filter((t) => !nextIds.has(t.id)),
  };
}
