/**
 * The phone's tab strip for one worktree, read from and written to the center tabs every device
 * shares (`band:center-tabs:<ws>`, `@band-app/client/center-tabs`). The phone shows chat and
 * terminal tabs. When it writes the list it keeps the other kinds (file, diff, browser) where
 * they were, through `keepHiddenTabs`, so closing a chat here never drops the desktop's browser.
 *
 * A chat the hub has but the list lacks (created by the CLI, or before the list existed) is shown
 * after the listed ones, the way the web's reconcile adds it. A chat tab whose chat the phone
 * doesn't know yet (made on the web a moment ago) is not shown, and a write keeps it in the list.
 */

import type { CenterTab, CenterTabs } from "@band-app/client/center-tabs";
import { keepHiddenTabs } from "@band-app/client/center-tabs";
import { isAttention, isRunning } from "../status-state.ts";

export interface PhoneTabs {
  /** Chat and terminal tabs in the shared order. */
  tabs: CenterTab[];
  /** The ids of `tabs`. */
  ids: string[];
  /** The shared active tab when it is one of `tabs`, else null. */
  active: string | null;
  /** How many tabs of other kinds the list holds (shown as "N more on desktop"). */
  hidden: number;
}

/** The kinds the phone shows. */
export function isPhoneKind(kind: string): boolean {
  return kind === "chat" || kind === "term";
}

/**
 * What the phone shows of `shared`, given the chats and terminals the hub has. A tab the hub
 * doesn't know is skipped. Chats and terminals the list lacks come after the listed ones.
 */
export function phoneTabs(
  shared: CenterTabs | null,
  knownChats: readonly string[],
  knownTerminals: readonly string[] = [],
): PhoneTabs {
  const kindOf = new Map<string, CenterTab["kind"]>();
  for (const id of knownChats) kindOf.set(id, "chat");
  for (const id of knownTerminals) kindOf.set(id, "term");
  const listed = (shared?.tabs ?? []).filter((t) => kindOf.get(t.id) === t.kind);
  const listedIds = new Set(listed.map((t) => t.id));
  const tabs: CenterTab[] = [
    ...listed.map((t): CenterTab => ({ id: t.id, kind: t.kind })),
    ...knownChats.filter((id) => !listedIds.has(id)).map((id): CenterTab => ({ id, kind: "chat" })),
    ...knownTerminals
      .filter((id) => !listedIds.has(id))
      .map((id): CenterTab => ({ id, kind: "term" })),
  ];
  const active = shared?.active && listedIds.has(shared.active) ? shared.active : null;
  // Tabs the phone cannot show: other kinds, and chats or terminals the hub no longer has.
  const hidden = (shared?.tabs ?? []).filter((t) => !listedIds.has(t.id)).length;
  return { tabs, ids: tabs.map((t) => t.id), active, hidden };
}

/**
 * The shared list after the phone changed its own tabs to `tabs` with `active`. Tabs of other
 * kinds, and chat or terminal tabs the phone didn't show (`shown` lacks them), stay where they
 * were.
 */
export function writePhoneTabs(
  shared: CenterTabs | null,
  shown: readonly string[],
  tabs: readonly CenterTab[],
  active: string | null,
): CenterTabs {
  const shownSet = new Set(shown);
  const next: CenterTabs = {
    tabs: tabs.map((t): CenterTab => ({ id: t.id, kind: t.kind })),
    active,
  };
  return keepHiddenTabs(next, shared, (t) => isPhoneKind(t.kind) && shownSet.has(t.id));
}

/** The tab to show after `closed` goes: the one after it, else the one before. */
export function neighbourOf(chats: readonly string[], closed: string): string | null {
  const i = chats.indexOf(closed);
  if (i === -1) return chats[0] ?? null;
  return chats[i + 1] ?? chats[i - 1] ?? null;
}

/** `chats` with `id` moved by `delta` places, clamped to the ends. */
export function moveChat(chats: readonly string[], id: string, delta: number): string[] {
  const from = chats.indexOf(id);
  if (from === -1) return [...chats];
  const to = Math.max(0, Math.min(chats.length - 1, from + delta));
  const next = chats.filter((c) => c !== id);
  next.splice(to, 0, id);
  return next;
}

/** A chat's agent state as its tab shows it. */
export type TabState = "running" | "attention" | "unread" | "idle";

/** The hub's per-chat agent status (`tabStatuses`), by chat id. */
export function chatStatuses(
  tabStatuses: readonly { chatId?: string; status: string }[] | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tabStatuses ?? []) if (t.chatId) out.set(t.chatId, t.status);
  return out;
}

/**
 * The chats with output the user hasn't seen: one whose turn ended (it was `working` and no longer
 * is) while another tab was shown. Showing a chat clears it.
 */
export function nextUnread(
  unread: ReadonlySet<string>,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  active: string | null,
): ReadonlySet<string> {
  const ended = [...before]
    .filter(([id, status]) => status === "working" && after.get(id) !== "working" && id !== active)
    .map(([id]) => id);
  // The same set when nothing changed, so React skips the update.
  if (ended.every((id) => unread.has(id)) && !(active && unread.has(active))) return unread;
  const next = new Set(unread);
  for (const id of ended) next.add(id);
  if (active) next.delete(active);
  return next;
}

export function tabState(
  chatId: string,
  statuses: ReadonlyMap<string, string>,
  unread: ReadonlySet<string>,
): TabState {
  const status = statuses.get(chatId);
  if (isAttention(status)) return "attention";
  if (isRunning(status)) return "running";
  return unread.has(chatId) ? "unread" : "idle";
}

/** The ids of the chats to keep mounted: `active` first, then the most recently shown, `limit` in all. */
export function keepAlive(
  recent: readonly string[],
  active: string | null,
  exists: (id: string) => boolean,
  limit: number,
): string[] {
  const out: string[] = [];
  for (const id of active ? [active, ...recent] : recent) {
    if (out.length >= limit) break;
    if (exists(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
