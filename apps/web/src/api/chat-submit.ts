/**
 * POST /api/chats/:chatId/messages
 *
 * Submit a user message. Decoupled from observation — the new chat-events
 * stream (`GET /api/chats/:chatId/events`) is where the client sees the
 * server's response. This endpoint returns immediately with `200 { ok: true }`
 * once the task is in flight (or queued if the agent is busy).
 *
 * Compared to the legacy `POST /api/tasks/:chatId/stream`:
 *   - No SSE stream in the response body. POST returns fast (no waiting on
 *     the agent's first byte).
 *   - 409 → queued. If a task is already running for this chat, the new
 *     message is pushed to the server-side queue and the response is 200.
 *     The client sees a `queue-updated` event on its subscription. No special
 *     error path on the client.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { createChat, getChat } from "../lib/chat-manager";
import { pushQueuedMessage } from "../lib/queued-message-store";
import { submitTask, TaskConflictError } from "../lib/task-runner";
import { saveUploadedFilesDetailed } from "../lib/upload-utils";

const log = createLogger("chat-submit");

interface SubmitBody {
  workspaceId: string;
  text: string;
  sessionId?: string;
  maxTurns?: number;
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

  const { workspaceId, text, sessionId, maxTurns, mode, model, codingAgentId, files } = body;
  if (!workspaceId || !text?.trim()) {
    sendJson(res, 400, { error: "workspaceId and text are required" });
    return;
  }

  // Lazy chat creation matches the legacy endpoint.
  const existing = getChat(chatId);
  if (!existing) {
    createChat(workspaceId, { id: chatId, name: "Chat", agent: codingAgentId });
  }

  // Resolve sessionId. The new chat-events client doesn't pass `sessionId`
  // in the submit body — under the event-log model the server is the
  // authoritative owner of "which session is this chat on", persisted as
  // `chat.activeSessionId`. Without this fallback, every send started a
  // brand-new agent session, the previous turn's JSONL was abandoned, and
  // the client saw "only one message in history" with no continuation of
  // the prior conversation. The explicit body field still wins so a
  // future client that wants to fork off an older session can do so.
  const resumeSessionId = sessionId ?? getChat(chatId)?.activeSessionId;

  // Upload any attached files first — needs to be sequential w.r.t. the
  // submit so the agent prompt references valid paths.
  let agentPrompt: string | undefined;
  let displayFiles: { mediaType: string; url: string; filename?: string }[] | undefined;
  if (files && files.length > 0) {
    const saved = await saveUploadedFilesDetailed(files);
    if (saved.length > 0) {
      const fileList = saved.map((s) => `- ${s.path}`).join("\n");
      agentPrompt = `I'm sharing these files with you:\n${fileList}\n\n${text}`;
      displayFiles = saved.map((s) => ({
        mediaType: s.mediaType,
        url: `/api/uploads/${s.storedName}`,
        filename: s.originalName,
      }));
    }
  }

  try {
    submitTask({
      workspaceId,
      chatId,
      prompt: text,
      sessionId: resumeSessionId,
      agentPrompt,
      displayFiles,
      maxTurns,
      mode,
      model,
      codingAgentId,
    });
    log.info({ chatId, workspaceId }, "chat-submit: task started");
    sendJson(res, 200, { ok: true, queued: false });
  } catch (err) {
    if (err instanceof TaskConflictError) {
      // Already running — queue instead. The subscriber sees a
      // `queue-updated` event automatically via subscribeQueue.
      pushQueuedMessage(chatId, {
        text,
        ...(displayFiles && displayFiles.length > 0 && { files: displayFiles }),
      });
      log.info({ chatId, workspaceId }, "chat-submit: task busy, message queued");
      sendJson(res, 200, { ok: true, queued: true });
      return;
    }
    if (err instanceof Error && err.message.startsWith("Workspace not found")) {
      sendJson(res, 404, { error: err.message });
      return;
    }
    log.error({ chatId, err }, "chat-submit: unexpected error");
    sendJson(res, 500, { error: "Internal server error" });
  }
}
