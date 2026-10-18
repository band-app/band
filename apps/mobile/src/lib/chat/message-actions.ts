/**
 * What the copy button on a chat row offers (the web's `MessageActions.tsx`).
 */

import type { ChatRow } from "./rows.ts";
import { copyText } from "./rows.ts";

export type MessageAction = "copy";

/** The actions for a row, in the order of the list. A row with no text has no Copy. */
export function messageActions(row: ChatRow): MessageAction[] {
  return copyText(row) ? ["copy"] : [];
}
