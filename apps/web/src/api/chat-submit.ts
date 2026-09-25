/**
 * POST /api/chats/:chatId/messages
 *
 * Submit a user message. Decoupled from observation: the client sees the
 * turn on its chat event stream (`GET /api/chats/:chatId/events`). Returns
 * `200 { ok: true, queued }` once the turn is in flight, or queued when one
 * is already running for this chat (the subscriber gets `queue-updated`).
 *
 * Attached files are saved under `~/.band/uploads` first and reach the agent
 * as ACP `resource_link` / `image` blocks (see `task-service`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { pushQueuedMessage } from "../server/services/_utils/queued-message-store";
import { saveUploadedFilesDetailed } from "../server/services/_utils/upload-utils";
import { chatService } from "../server/services/chat-service";
import {
  type TaskAttachment,
  TaskConflictError,
  taskService,
  WorkspaceNotFoundError,
} from "../server/services/task-service";

const log = createLogger("chat-submit");

interface SubmitBody {
  workspaceId: string;
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

  const { workspaceId, text, sessionId, mode, model, codingAgentId, files } = body;
  if (!workspaceId || !text?.trim()) {
    sendJson(res, 400, { error: "workspaceId and text are required" });
    return;
  }

  if (!chatService.get(chatId)) {
    chatService.create(workspaceId, { id: chatId, name: "Chat", agent: codingAgentId });
  }

  let attachments: TaskAttachment[] = [];
  if (files && files.length > 0) {
    const saved = await saveUploadedFilesDetailed(files);
    // `saveUploadedFilesDetailed` skips entries that aren't
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
      url: `/api/uploads/${s.storedName}`,
      filename: s.originalName,
    }));
  }

  try {
    taskService.submitTask({
      workspaceId,
      chatId,
      prompt: text,
      sessionId,
      attachments,
      mode,
      model,
      codingAgentId,
    });
    log.info({ chatId, workspaceId }, "chat-submit: task started");
    sendJson(res, 200, { ok: true, queued: false });
  } catch (err) {
    if (err instanceof TaskConflictError) {
      // A turn is running; queue the message. The drain in task-service
      // rebuilds the attachments from the saved paths.
      pushQueuedMessage(chatId, {
        text,
        ...(attachments.length > 0 && { files: attachments }),
      });
      log.info({ chatId, workspaceId }, "chat-submit: task busy, message queued");
      sendJson(res, 200, { ok: true, queued: true });
      return;
    }
    if (err instanceof WorkspaceNotFoundError) {
      sendJson(res, 404, { error: err.message });
      return;
    }
    log.error({ chatId, err }, "chat-submit: unexpected error");
    sendJson(res, 500, { error: "Internal server error" });
  }
}
