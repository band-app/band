/**
 * The permission or question the agent waits on, which the chat pins above the composer so it
 * cannot scroll out of sight. The agent asks one thing at a time, and only in the turn that is
 * running, so the last message holds it.
 */

import type { ChatMessage, Entry } from "@band-app/client/transcript";

export type RequestEntry = Extract<Entry, { kind: "permission" | "elicitation" }>;

export function pendingRequest(messages: readonly ChatMessage[]): RequestEntry | undefined {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return undefined;
  return last.entries.find(
    (e): e is RequestEntry => (e.kind === "permission" || e.kind === "elicitation") && !e.answer,
  );
}

/** The text a permission request shows besides its title: the content the agent attached. */
export function permissionTexts(entry: Extract<RequestEntry, { kind: "permission" }>): string[] {
  return (entry.request.toolCall.content ?? []).flatMap((c) =>
    c.type === "content" && c.content.type === "text" ? [c.content.text] : [],
  );
}

/** A compact view of a tool call's input, for the permission card ("command: pnpm test"). */
export function permissionInput(entry: Extract<RequestEntry, { kind: "permission" }>): string[] {
  const input = entry.request.toolCall.rawInput;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.entries(input as Record<string, unknown>).flatMap(([key, value]) => {
    if (value === undefined || value === null || value === "") return [];
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return [`${key}: ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`];
  });
}

/** One line naming what the request asks: the tool for a permission, the question for a form. */
export function requestText(entry: RequestEntry): string {
  if (entry.kind === "permission") return entry.request.toolCall.title ?? "a tool";
  return entry.request.message || "a question";
}
