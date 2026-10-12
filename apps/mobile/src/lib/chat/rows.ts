/**
 * The chat transcript as list rows. An assistant message holds a whole turn, which can be
 * hundreds of entries, so one row per message would defeat the virtualized list. Each user
 * message is a row, each part of an assistant message (`groupEntries` in
 * `@band-app/client/tool-summary`: a text, a thought, a tool call or a folded run of tool calls)
 * is a row, and a finished turn ends with a footer row.
 *
 * Streaming replaces only the last message, so every earlier row keeps its object and the list
 * re-renders only the rows at the end.
 */

import { groupEntries, type MessagePart } from "@band-app/client/tool-summary";
import type { ChatMessage, Entry } from "@band-app/client/transcript";

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;
type UserMessage = Extract<ChatMessage, { role: "user" }>;

export type ChatRow =
  | { kind: "user"; key: string; message: UserMessage }
  | { kind: "part"; key: string; message: AssistantMessage; part: MessagePart }
  | { kind: "footer"; key: string; message: AssistantMessage }
  | { kind: "thinking"; key: string };

function isWaiting(entry: Entry): boolean {
  return (entry.kind === "permission" || entry.kind === "elicitation") && !entry.answer;
}

function partKey(part: MessagePart): string {
  return part.kind === "entry" ? part.entry.id : part.id;
}

/** Whether a part shows anything; blank text renders nothing, like the web chat. */
function visible(part: MessagePart): boolean {
  return !(part.kind === "entry" && part.entry.kind === "text" && !part.entry.text.trim());
}

/**
 * Rows are cached per message: the reducer keeps the object of every message the stream did
 * not touch, so its rows keep their objects and memoized cells skip rendering.
 */
const partsCache = new WeakMap<AssistantMessage, ChatRow[]>();
const userCache = new WeakMap<UserMessage, ChatRow>();

function userRow(message: UserMessage): ChatRow {
  let row = userCache.get(message);
  if (!row) {
    row = { kind: "user", key: message.id, message };
    userCache.set(message, row);
  }
  return row;
}

function partRows(message: AssistantMessage): ChatRow[] {
  const cached = partsCache.get(message);
  if (cached) return cached;
  const rows: ChatRow[] = groupEntries(message.entries)
    .filter(visible)
    .map((part) => ({ kind: "part", key: `${message.id}/${partKey(part)}`, message, part }));
  partsCache.set(message, rows);
  return rows;
}

/**
 * `streaming` is true while a turn runs. The last assistant message gets no footer then, and a
 * thinking row ends the list unless the agent waits on the user.
 */
export function buildRows(messages: readonly ChatMessage[], streaming: boolean): ChatRow[] {
  const rows: ChatRow[] = [];
  messages.forEach((message, i) => {
    if (message.role === "user") {
      rows.push(userRow(message));
      return;
    }
    rows.push(...partRows(message));
    const live = streaming && i === messages.length - 1;
    if (!live && message.entries.length > 0) {
      rows.push({ kind: "footer", key: `${message.id}/footer`, message });
    }
  });
  const last = messages[messages.length - 1];
  const waiting = last?.role === "assistant" && last.entries.some(isWaiting);
  if (streaming && !waiting) rows.push({ kind: "thinking", key: "thinking" });
  return rows;
}

/** What a long press on a row copies: the message's text, as the web's copy button does. */
export function copyText(row: ChatRow): string {
  if (row.kind === "user") return row.message.text.trim();
  if (row.kind === "thinking") return "";
  return row.message.entries
    .flatMap((e) => (e.kind === "text" && e.text.trim() ? [e.text.trim()] : []))
    .join("\n\n");
}

/** A FlashList recycling pool per row shape, so a text cell is never reused for a diff. */
export function rowType(row: ChatRow): string {
  if (row.kind !== "part") return row.kind;
  return row.part.kind === "tools" ? "tools" : row.part.entry.kind;
}
