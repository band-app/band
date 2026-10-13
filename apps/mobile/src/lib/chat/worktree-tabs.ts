/**
 * The phone's tab strip for one worktree, read from and written to the center tabs every device
 * shares (`band:center-tabs:<ws>`, `@band-app/client/center-tabs`). The phone shows chat tabs
 * only. When it writes the list it keeps the other kinds (terminal, file, diff, browser) where
 * they were, through `keepHiddenTabs`, so closing a chat here never drops the desktop's terminal.
 *
 * A chat the hub has but the list lacks (created by the CLI, or before the list existed) is shown
 * after the listed ones, the way the web's reconcile adds it. A chat tab whose chat the phone
 * doesn't know yet (made on the web a moment ago) is not shown, and a write keeps it in the list.
 */

import type { CenterTab, CenterTabs } from "@band-app/client/center-tabs";
import { keepHiddenTabs } from "@band-app/client/center-tabs";

export interface PhoneTabs {
  /** Chat ids in the shared order. */
  chats: string[];
  /** The shared active tab when it is one of `chats`, else null. */
  active: string | null;
  /** How many tabs of other kinds the list holds (shown as "N more on desktop"). */
  hidden: number;
}

/** What the phone shows of `shared`, given the chats the hub has (`known`). */
export function phoneTabs(shared: CenterTabs | null, known: readonly string[]): PhoneTabs {
  const knownSet = new Set(known);
  const listed = (shared?.tabs ?? []).filter((t) => t.kind === "chat" && knownSet.has(t.id));
  const listedIds = new Set(listed.map((t) => t.id));
  const chats = [...listed.map((t) => t.id), ...known.filter((id) => !listedIds.has(id))];
  const active = shared?.active && listedIds.has(shared.active) ? shared.active : null;
  const hidden = (shared?.tabs ?? []).filter((t) => t.kind !== "chat").length;
  return { chats, active, hidden };
}

/**
 * The shared list after the phone changed its own tabs to `chats` with `active`. Tabs of other
 * kinds, and chat tabs the phone didn't show (`shown` lacks them), stay where they were.
 */
export function writePhoneTabs(
  shared: CenterTabs | null,
  shown: readonly string[],
  chats: readonly string[],
  active: string | null,
): CenterTabs {
  const shownSet = new Set(shown);
  const next: CenterTabs = {
    tabs: chats.map((id): CenterTab => ({ id, kind: "chat" })),
    active,
  };
  return keepHiddenTabs(next, shared, (t) => t.kind === "chat" && shownSet.has(t.id));
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
  if (status === "needs_attention") return "attention";
  if (status === "working") return "running";
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
