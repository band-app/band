/**
 * Turns chat event log rows into the wire events the chat stream and the
 * history endpoint send.
 *
 * Agents stream text a few tokens per `session/update`, so a turn can log
 * hundreds of `agent_message_chunk` rows. Replay merges each run of
 * consecutive text chunks of one kind and one `messageId` into a single
 * event carrying the run's last row id. Merging only ever happens inside
 * the range being sent, so a client resuming from a cursor never gets text
 * it already has.
 */

import type { ChatEvent, SessionUpdate } from "../../../shared/chat-events";
import type { ChatEventRow } from "../../infra/db/queries/chat-events";

type ChunkUpdate = Extract<
  SessionUpdate,
  { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" }
>;

function textChunk(row: ChatEventRow): ChunkUpdate | null {
  const event = row.event;
  if (event.type !== "update") return null;
  const u = event.update;
  if (
    (u.sessionUpdate === "agent_message_chunk" ||
      u.sessionUpdate === "agent_thought_chunk" ||
      u.sessionUpdate === "user_message_chunk") &&
    u.content.type === "text"
  ) {
    return u;
  }
  return null;
}

export function rowsToEvents(rows: ChatEventRow[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  let run: { update: ChunkUpdate; text: string; lastId: number } | null = null;

  const flush = () => {
    if (!run) return;
    out.push({
      type: "update",
      update: { ...run.update, content: { type: "text", text: run.text } },
      eventId: run.lastId,
    });
    run = null;
  };

  for (const row of rows) {
    const chunk = textChunk(row);
    if (
      chunk &&
      run &&
      run.update.sessionUpdate === chunk.sessionUpdate &&
      (run.update.messageId ?? null) === (chunk.messageId ?? null)
    ) {
      run.text += chunk.content.type === "text" ? chunk.content.text : "";
      run.lastId = row.id;
      continue;
    }
    flush();
    if (chunk) {
      run = {
        update: chunk,
        text: chunk.content.type === "text" ? chunk.content.text : "",
        lastId: row.id,
      };
      continue;
    }
    out.push({ ...row.event, eventId: row.id } as ChatEvent);
  }
  flush();
  return out;
}
