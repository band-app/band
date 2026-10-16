/**
 * The center layout's tab list in this browser's client state. The pure
 * parsing and merge rules live in `@band-app/client/center-tabs`; this file
 * is the part that reads `clientStorage` and the layout.
 */

import {
  CENTER_TAB_KINDS,
  type CenterTab,
  type CenterTabKind,
  type CenterTabs,
  centerTabsKey,
  parseCenterTabs,
} from "@band-app/client/center-tabs";
import type { LayoutApi } from "../components/layout/model";
import { clientStorage } from "./client-state";

export function readCenterTabs(worktreeId: string): CenterTabs | null {
  const raw = clientStorage.getItem(centerTabsKey(worktreeId));
  if (!raw) return null;
  try {
    return parseCenterTabs(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The layout's top-level tabs, group by group, left to right. */
export function centerTabsFromApi(api: LayoutApi): CenterTabs {
  const tabs: CenterTab[] = [];
  for (const group of api.groups) {
    for (const panel of group.panels) {
      const kind = panel.api.component;
      if (CENTER_TAB_KINDS.has(kind)) tabs.push({ id: panel.id, kind: kind as CenterTabKind });
    }
  }
  return { tabs, active: api.activePanel?.id ?? null };
}

export function writeCenterTabs(worktreeId: string, next: CenterTabs): void {
  const key = centerTabsKey(worktreeId);
  const raw = JSON.stringify(next);
  if (clientStorage.getItem(key) === raw) return;
  clientStorage.setItem(key, raw);
}
