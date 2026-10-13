/**
 * What a long press on a chat row offers, and the time it shows. The web's message actions are
 * Copy and the time sent (`MessageActions.tsx`); the phone shows both in one native action sheet.
 */

import type { ChatRow } from "./rows.ts";
import { copyText } from "./rows.ts";

export type MessageAction = "copy";

/** When the row's message was sent or began (epoch ms), if the hub recorded it. */
export function rowTime(row: ChatRow): number | undefined {
  return row.kind === "thinking" ? undefined : row.message.createdAt;
}

/** The actions for a row, in the order of the sheet. A row with no text has no Copy. */
export function messageActions(row: ChatRow): MessageAction[] {
  return copyText(row) ? ["copy"] : [];
}

const UNITS: [string, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "just now", "5 minutes ago", "10 months ago", like the web's `timeAgo`. */
export function timeAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  for (const [unit, size] of UNITS) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
