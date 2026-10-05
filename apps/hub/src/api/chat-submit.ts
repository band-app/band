/**
 * POST /api/chats/:chatId/messages
 *
 * Submit a user message. Decoupled from observation: the client sees the
 * turn on its chat event stream (`GET /api/chats/:chatId/events`). Returns
 * `200 { ok: true, queued }` once the turn is in flight, or queued behind the
 * running turn and any earlier queued messages (the subscriber gets
 * `queue-updated`).
 *
 * Attached files are saved under `~/.band/uploads` first and reach the agent
 * as ACP `resource_link` / `image` blocks (see `task-service`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { SESSION_ID_PATTERN } from "../server/services/_utils/session-id";
import { saveWorktreeUploads } from "../server/services/_utils/upload-utils";
import { chatService } from "../server/services/chat-service";
import {
  type TaskAttachment,
  taskService,
  WorktreeNotFoundError,
} from "../server/services/task-service";

const log = createLogger("chat-submit");

interface SubmitBody {
  worktreeId: string;
  text: string;
  sessionId?: string;
  mode?: string;
  model?: string;
  codingAgentId?: string;
  files?: { mediaType: string; url: string; filename?: string }[];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function handleChatSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
): Promise<void> {
  let body: SubmitBody;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { worktreeId, text, sessionId, mode, model, codingAgentId, files } = body;
  if (!worktreeId || !text?.trim()) {
    sendJson(res, 400, { error: "worktreeId and text are required" });
    return;
  }
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    sendJson(res, 400, { error: "invalid sessionId" });
    return;
  }

  if (!chatService.get(chatId)) {
    chatService.create(worktreeId, { id: chatId, name: "Chat", agent: codingAgentId });
  }

  let attachments: TaskAttachment[] = [];
  if (files && files.length > 0) {
    const saved = await saveWorktreeUploads(worktreeId, files);
    // `saveWorktreeUploads` skips entries that aren't
    // `data:<mime>;base64,...` URLs; say so rather than drop them silently.
    if (saved.length !== files.length) {
      log.warn(
        { chatId, submitted: files.length, saved: saved.length },
        "chat-submit: some file uploads were dropped (malformed data URL?)",
      );
    }
    attachments = saved.map((s) => ({
      path: s.path,
      mediaType: s.mediaType,
      url: s.url,
      filename: s.originalName,
    }));
  }

  try {
    const result = taskService.submitOrQueueTask({
      worktreeId,
      chatId,
      prompt: text,
      sessionId,
      attachments,
      mode,
      model,
      codingAgentId,
    });
    log.info(
      { chatId, worktreeId },
      result.queued ? "chat-submit: chat busy, message queued" : "chat-submit: task started",
    );
    sendJson(res, 200, { ok: true, queued: result.queued });
  } catch (err) {
    if (err instanceof WorktreeNotFoundError) {
      sendJson(res, 404, { error: err.message });
      return;
    }
    log.error({ chatId, err }, "chat-submit: unexpected error");
    sendJson(res, 500, { error: "Internal server error" });
  }
}
