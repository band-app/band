/**
 * Post-session capture (plan step 5.4). When a chat is removed and
 * `context.captureLearnings` is on, the hub appends a short summary of the
 * session to the project context's learnings, marked `auto-captured`.
 *
 * The summary is a heuristic over the chat's own log, because the agent's
 * title is the only summary Band keeps and it is not a model call. It is the
 * title, the first and last request, and the closing reply. The text goes
 * through the secret redaction before it is written.
 */

import { createLogger } from "@band-app/logger";
import type { SessionUpdate } from "@band-app/shared/chat-events";
import { ChatEventQueries } from "../infra/db/queries/chat-events";
import type { ChatRow } from "../infra/db/queries/chats";
import { redactSecrets } from "./_utils/context-redaction";
import { contextToolsService, sessionFromChat } from "./context-tools-service";
import { settingsService } from "./settings-service";

const log = createLogger("context-capture");
const events = new ChatEventQueries();

const MAX_REQUEST = 600;
const MAX_REPLY = 1200;

// Redact before cutting, so a cut cannot leave a secret fragment too short to match.
const clip = (text: string, max: number) => {
  const clean = redactSecrets(text);
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}...` : clean;
};

function chunkText(update: SessionUpdate): string {
  return update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
    ? update.content.text
    : "";
}

/** Builds the summary from the chat's log, or undefined when the session did nothing. */
function summarize(chat: ChatRow): string | undefined {
  const sessionId = chat.activeSessionId;
  if (!sessionId) return undefined;
  const revision = events.currentRevision(sessionId);
  if (revision === 0) return undefined;
  const promptRows = events.readPrompts(sessionId, revision);
  const prompts: string[] = [];
  for (const row of promptRows) if (row.event.type === "prompt") prompts.push(row.event.text);
  if (prompts.length === 0) return undefined;
  // Only the last turn's rows are read, not the whole log.
  let reply = "";
  const lastPromptId = promptRows.at(-1)?.id ?? 0;
  for (const row of events.readUpdatesAfter(sessionId, revision, lastPromptId, [
    "agent_message_chunk",
    "tool_call",
  ])) {
    if (row.event.type !== "update") continue;
    // Narration before a tool call is not part of the answer.
    if (row.event.update.sessionUpdate === "tool_call") reply = "";
    reply += chunkText(row.event.update);
  }
  const lines = [
    `Session ${chat.activeSessionSummary ? `"${chat.activeSessionSummary}"` : chat.name}, ${prompts.length} request${prompts.length === 1 ? "" : "s"}.`,
    `First request: ${clip(prompts[0].trim(), MAX_REQUEST)}`,
  ];
  if (prompts.length > 1)
    lines.push(`Last request: ${clip(prompts.at(-1)?.trim() ?? "", MAX_REQUEST)}`);
  if (reply.trim()) lines.push(`Closing reply: ${clip(reply.trim(), MAX_REPLY)}`);
  return lines.join("\n\n");
}

export const contextCaptureService = {
  /**
   * Called by `ChatService` before it drops a chat's log. Reads the log at once
   * and writes in the background, so a removal never waits on git or fails on it.
   */
  captureChat(chat: ChatRow, repo?: string, projectId?: string): void {
    if (settingsService.get().context?.captureLearnings !== true) return;
    // A retro chat holds the whole context as its prompt, so capturing it would feed the next retro its own input.
    if (chat.labels?.["band:retro"]) return;
    try {
      const text = summarize(chat);
      if (!text) return;
      const session = sessionFromChat(chat, repo, projectId);
      if (!session.project) return;
      void contextToolsService
        .appendLearning(session, { text, tags: ["auto-captured"], source: "auto-captured" })
        .catch((err) => log.warn({ chatId: chat.id, err: String(err) }, "capture skipped"));
    } catch (err) {
      log.warn({ chatId: chat.id, err: String(err) }, "capture failed");
    }
  },
};
