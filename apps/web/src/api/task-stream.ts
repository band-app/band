import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { createUIMessageStream, pipeUIMessageStreamToResponse } from "ai";
import { createChat, getChat } from "../lib/chat-manager";
import { getQueuedMessages } from "../lib/queued-message-store";
import { getSessionEventsAfter } from "../lib/session-store";
import {
  getSessionBuffer,
  getTask,
  type StreamChunk,
  submitTask,
  subscribe as subscribeTask,
  TaskConflictError,
} from "../lib/task-runner";
import { saveUploadedFilesDetailed } from "../lib/upload-utils";

const log = createLogger("task-stream");

/**
 * Known chunk types that don't belong in the AI SDK's UIMessageStream protocol.
 * These are internal application events the task runner broadcasts for session
 * persistence but aren't valid UIMessageChunk variants (they'd fail strict
 * Zod validation on the client).
 */
const INTERNAL_CHUNK_TYPES = new Set(["user-message"]);

/**
 * Prepare a StreamChunk for writing to the AI SDK stream writer.
 *
 * 1. Strips the `eventId` field — `uiMessageChunkSchema` uses `z.strictObject`
 *    which rejects unknown keys.
 * 2. Returns `null` for internal-only chunk types that aren't valid
 *    UIMessageChunk variants.
 */
function toUIChunk(chunk: StreamChunk): StreamChunk | null {
  if (INTERNAL_CHUNK_TYPES.has(chunk.type)) return null;
  if (chunk.eventId == null) return chunk;
  const { eventId: _, ...rest } = chunk;
  return rest as StreamChunk;
}

interface SubmitBody {
  workspaceId: string;
  prompt: string;
  sessionId?: string;
  maxTurns?: number;
  mode?: string;
  model?: string;
  codingAgentId?: string;
  files?: { mediaType: string; url: string; filename?: string }[];
}

/**
 * Read the full request body as a string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Stream task events to the client as SSE using the AI SDK.
 *
 * Implements the same 3-phase gap-fill logic as the old tRPC subscription:
 *   Phase 1 — replay missed events from the session buffer
 *   Phase 2 — wait briefly for a task to start (if not already running)
 *   Phase 2b — catch-up replay scoped to the current task
 *   Phase 3 — stream live events until the task finishes
 */
function streamTask(
  res: ServerResponse,
  chatId: string,
  sessionId: string | undefined,
  afterEventId: number | undefined,
): void {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let highWaterMark = afterEventId ?? 0;

      // Register the listener FIRST so we capture events from tasks that
      // are already running (avoids race between submit and subscribe).
      const queue: StreamChunk[] = [];
      let notify: (() => void) | null = null;

      const unsubscribe = subscribeTask(chatId, (chunk: StreamChunk) => {
        // Dedup: skip events we already replayed from the buffer
        if (chunk.eventId != null && chunk.eventId <= highWaterMark) return;
        queue.push(chunk);
        notify?.();
      });

      // Clean up when the client disconnects
      const onClose = () => {
        unsubscribe();
        notify?.();
      };
      res.on("close", onClose);

      try {
        // Phase 1: Replay missed events from in-memory buffer (gap-fill)
        if (sessionId && afterEventId != null) {
          const missed = getSessionEventsAfter(sessionId, afterEventId);
          for (const row of missed) {
            // row.chunk is the already-parsed StreamChunk (SessionEventRecord).
            const uiChunk = toUIChunk({ ...row.chunk, eventId: row.id } as StreamChunk);
            if (uiChunk) writer.write(uiChunk);
            highWaterMark = Math.max(highWaterMark, row.id);
          }
        }

        // Phase 2: Live events — check if a task is running or wait briefly
        let task = getTask(chatId);
        if (!task || task.status !== "running") {
          for (let i = 0; i < 10 && !res.destroyed; i++) {
            await new Promise((r) => setTimeout(r, 50));
            if (queue.length > 0) break;
            task = getTask(chatId);
            if (task?.status === "running") break;
          }
        }

        // Phase 2b: Catch-up replay — if a task is running but no events
        // arrived via the live listener yet, replay buffered events scoped
        // to the current task (avoids re-yielding prior tasks' events).
        let caughtUp = false;
        if (queue.length === 0 && task?.sessionId) {
          const buf = getSessionBuffer(task.sessionId);
          if (buf && buf.events.length > 0) {
            const taskStartEventId = task.firstEventId ?? Number.POSITIVE_INFINITY;
            log.info(
              {
                chatId,
                sessionId: task.sessionId,
                bufferedCount: buf.events.length,
                taskStartEventId,
              },
              "task-stream: replaying buffered events (catch-up)",
            );
            for (const buffered of buf.events) {
              if (buffered.eventId != null && buffered.eventId <= highWaterMark) continue;
              if (buffered.eventId != null && buffered.eventId < taskStartEventId) continue;
              const uiChunk = toUIChunk(buffered);
              if (uiChunk) {
                writer.write(uiChunk);
                caughtUp = true;
              }
              if (buffered.eventId != null) {
                highWaterMark = Math.max(highWaterMark, buffered.eventId);
              }
            }
          }
        }

        // If still no running task and no events captured, check if the task
        // already failed/completed.
        if (queue.length === 0 && !caughtUp && (!task || task.status !== "running")) {
          log.warn(
            { chatId, taskStatus: task?.status, queueLen: queue.length },
            "task-stream: no running task and no events — closing stream early",
          );
          if (task?.status === "failed") {
            writer.write({ type: "error", errorText: "Task failed" } as unknown as StreamChunk);
            writer.write({ type: "finish" } as unknown as StreamChunk);
          }
          return;
        }

        // Phase 3: Stream live events
        while (!res.destroyed) {
          while (queue.length > 0) {
            const chunk = queue.shift()!;
            const uiChunk = toUIChunk(chunk);
            if (uiChunk) writer.write(uiChunk);

            // When a task finishes, end the stream only if no follow-up
            // work remains (queued messages or an already-started next task).
            if (chunk.type === "finish") {
              const hasQueued = getQueuedMessages(chatId).length > 0;
              const taskRunning = getTask(chatId)?.status === "running";
              if (!hasQueued && !taskRunning) {
                return;
              }
            }
          }
          await new Promise<void>((r) => {
            notify = r;
          });
          notify = null;
        }
      } finally {
        unsubscribe();
        res.off("close", onClose);
      }
    },
  });

  pipeUIMessageStreamToResponse({ response: res, stream, status: 200 });
}

/**
 * Handle POST /api/tasks/:chatId/stream — submit a task and stream the response.
 */
async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
): Promise<void> {
  let body: SubmitBody;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  const { workspaceId, prompt, sessionId, maxTurns, mode, model, codingAgentId, files } = body;

  if (!workspaceId || !prompt?.trim()) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "workspaceId and prompt are required" }));
    return;
  }

  // Resolve chatId — lazily create chat record if needed (same as tasks.submit)
  const existing = getChat(chatId);
  if (!existing) {
    createChat(workspaceId, { id: chatId, name: "Chat", agent: codingAgentId });
  }

  // Handle file uploads — write each attachment to ~/.band/uploads/
  // and build (a) a path list to inject into the agent prompt and
  // (b) a display-only metadata array, with /api/uploads/{name} URLs,
  // that we hand to submitTask so the user-message broadcast (and
  // therefore the persisted session JSONL) carries the file parts.
  // Without (b), reloading the session would re-render the user
  // bubble as text-only and lose any attached images.
  let agentPrompt: string | undefined;
  let displayFiles: { mediaType: string; url: string; filename?: string }[] | undefined;
  if (files && files.length > 0) {
    const saved = await saveUploadedFilesDetailed(files);
    if (saved.length > 0) {
      const fileList = saved.map((s) => `- ${s.path}`).join("\n");
      agentPrompt = `I'm sharing these files with you:\n${fileList}\n\n${prompt}`;
      displayFiles = saved.map((s) => ({
        mediaType: s.mediaType,
        url: `/api/uploads/${s.storedName}`,
        filename: s.originalName,
      }));
    }
  }

  // Submit the task
  try {
    submitTask({
      workspaceId,
      chatId,
      prompt,
      sessionId,
      agentPrompt,
      displayFiles,
      maxTurns,
      mode,
      model,
      codingAgentId,
    });
  } catch (err) {
    if (err instanceof TaskConflictError) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task already running for this chat pane" }));
      return;
    }
    if (err instanceof Error && err.message.startsWith("Workspace not found")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    throw err;
  }

  log.info({ chatId, workspaceId }, "task-stream: POST — task submitted, opening SSE stream");
  streamTask(res, chatId, sessionId, undefined);
}

/**
 * Handle GET /api/tasks/:chatId/stream — reconnect to an active stream.
 */
function handleGet(req: IncomingMessage, res: ServerResponse, chatId: string): void {
  // Read reconnection parameters
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const lastEventIdHeader = req.headers["last-event-id"];
  const afterEventId =
    lastEventIdHeader != null ? parseInt(String(lastEventIdHeader), 10) : undefined;

  // Check if there's an active task to reconnect to
  const task = getTask(chatId);
  if (!task || task.status !== "running") {
    res.writeHead(204);
    res.end();
    return;
  }

  log.info({ chatId, sessionId, afterEventId }, "task-stream: GET — reconnecting to active stream");
  streamTask(res, chatId, sessionId ?? task.sessionId, afterEventId);
}

/**
 * Main request handler for /api/tasks/:chatId/stream.
 */
export function handleTaskStream(req: IncomingMessage, res: ServerResponse, chatId: string): void {
  if (req.method === "POST") {
    handlePost(req, res, chatId).catch((err) => {
      log.error({ chatId, err }, "task-stream: POST handler error");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  if (req.method === "GET") {
    handleGet(req, res, chatId);
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}
