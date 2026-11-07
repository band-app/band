/**
 * Which editor selection a worktree's composer has already used. A selection is attached to one
 * message at most, and dismissing the chip also uses it up. The stamp of the last used selection is
 * kept per worktree on this device, so another chat or an app restart does not offer it again. A new
 * selection has a new stamp. No React Native imports, so node:test runs it.
 */
import type { EditorSelectionInfo } from "./selection";

/** The same lifetime the hub gives a selection. */
export const CONSUMED_TTL_MS = 30 * 60 * 1000;

export type ConsumedMap = Record<string, { stamp: string; at: number }>;

export function selectionStamp(info: EditorSelectionInfo): string {
  return `${info.updatedAt ?? ""}|${info.selection.address}`;
}

export function parseConsumed(raw: string | null | undefined, now: number): ConsumedMap {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};
    const out: ConsumedMap = {};
    for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
      const e = entry as { stamp?: unknown; at?: unknown } | null;
      if (
        e &&
        typeof e.stamp === "string" &&
        typeof e.at === "number" &&
        now - e.at <= CONSUMED_TTL_MS
      ) {
        out[id] = { stamp: e.stamp, at: e.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function markConsumed(
  map: ConsumedMap,
  worktreeId: string,
  info: EditorSelectionInfo,
  now: number,
): ConsumedMap {
  return { ...map, [worktreeId]: { stamp: selectionStamp(info), at: now } };
}

/** The selection to offer, or null when it was already sent or dismissed. */
export function unconsumed(
  map: ConsumedMap,
  worktreeId: string,
  info: EditorSelectionInfo | null,
): EditorSelectionInfo | null {
  if (!info) return null;
  return map[worktreeId]?.stamp === selectionStamp(info) ? null : info;
}
