/**
 * Chat routes on the worker's local listener, for
 * the desktop app on this machine. They speak the hub's wire format, so the
 * UI points the same code at `127.0.0.1:<port>` instead of the hub:
 *
 * - `GET /api/chats/:chatId/events`: the chat's event stream, as the hub's
 *   `api/chat-events.ts` sends it.
 * - `GET /api/chats/:chatId/history?before=<id>`: older turns.
 * - `POST /api/chats/:chatId/messages`: send a message (files as data URLs).
 * - `POST /api/chats/:chatId/stop`: stop the running turn.
 * - `POST /api/chats/:chatId/permission`, `.../elicitation`: answer a request.
 *
 * The direct listener (`direct.ts`) has already checked the token. These
 * routes check that the chat is one this worker owns, in the worktree the
 * token is for. Only a chat the worker does not own answers 404, which tells
 * the app to use the hub; an answer to a request that is gone is a 409.
 */

import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { openSseStream, type SseWriter } from "@band-app/chat-runtime/sse-writer";
import {
  type ChatEvent,
  HISTORY_PAGE_SIZE,
  SESSION_ID_PATTERN,
} from "@band-app/shared/chat-events";
import type { ChatMessage, ChatOwner } from "./owner.ts";

/** Largest request body: a message with its attached files. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** How long a stream or history read waits for the chat's log to be copied in before the hub serves it. */
const READY_WAIT_MS = 5_000;

const CHAT_ROUTE = /^\/api\/chats\/([^/]+)\/(events|history|messages|stop|permission|elicitation)$/;

/** Whether a path is one of these routes. */
export function isChatRoute(pathname: string): boolean {
  return CHAT_ROUTE.test(pathname);
}

export interface ChatRouteContext {
  owner: ChatOwner;
  /** The worktree the request's token is for. */
  worktreeId: string;
  /** Where uploads for a worktree go on this machine: `<uploads>/<worktreeId>`. */
  uploadsDir: string | undefined;
  /** CORS headers for the desktop app's page. */
  headers: Record<string, string>;
}

function parseIntOrUndefined(value: string | string[] | null | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : undefined;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function handleChatRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatRouteContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const match = url.pathname.match(CHAT_ROUTE);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...ctx.headers,
    });
    res.end(JSON.stringify(body));
  };
  if (!match) return json(404, { error: "Not found" });
  let chatId: string;
  try {
    chatId = decodeURIComponent(match[1]);
  } catch {
    return json(400, { error: "Bad chat id" });
  }
  const route = match[2];
  const { owner } = ctx;
  if (!owner.isOwned(chatId)) return json(404, { error: "This worker does not run the chat" });
  if (owner.worktreeId(chatId) !== ctx.worktreeId) {
    return json(403, { error: "The token is for another worktree" });
  }

  const wantMethod = route === "events" || route === "history" ? "GET" : "POST";
  if (req.method !== wantMethod) return json(405, { error: `Use ${wantMethod}` });

  // A log still being copied from the hub after a short wait: the hub serves the stream and
  // history until the copy is done, instead of the app waiting for it.
  if (wantMethod === "GET" && !(await owner.readyWithin(chatId, READY_WAIT_MS))) {
    return json(503, { error: "The chat's history is not copied from the hub yet" });
  }

  try {
    if (route === "events") return await streamEvents(req, res, ctx, chatId, url);
    if (route === "history") return json(200, history(owner, chatId, url));
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return json(400, { error: "The body must be a JSON object" });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return json(400, { error: "The body is not JSON" });
    }
    switch (route) {
      case "messages": {
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) return json(400, { error: "text is required" });
        if (body.sessionId !== undefined && !SESSION_ID_PATTERN.test(String(body.sessionId))) {
          return json(400, { error: "invalid session id" });
        }
        const message: ChatMessage = {
          text,
          files: await saveUploads(ctx, body.files),
          ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
          ...(typeof body.mode === "string" ? { mode: body.mode } : {}),
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof body.codingAgentId === "string" ? { codingAgentId: body.codingAgentId } : {}),
        };
        const { queued } = await owner.send(chatId, message);
        return json(200, { ok: true, queued });
      }
      case "stop":
        return json(200, { ok: true, stopped: owner.stop(chatId) });
      case "permission": {
        const requestId = String(body.requestId ?? "");
        const optionId = typeof body.optionId === "string" ? body.optionId : null;
        const ok = owner.answerPermission(chatId, requestId, optionId);
        return ok ? json(200, { ok: true }) : json(409, { error: "No such request" });
      }
      case "elicitation": {
        const ok = owner.answerElicitation(
          chatId,
          String(body.requestId ?? ""),
          body.response as acp.CreateElicitationResponse,
        );
        return ok ? json(200, { ok: true }) : json(409, { error: "No such request" });
      }
    }
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Files of a message, as the hub saves them for a worktree on a worker: `<uploads>/<worktree>/<name>`. */
async function saveUploads(
  ctx: ChatRouteContext,
  raw: unknown,
): Promise<ChatMessage["files"] | undefined> {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!ctx.uploadsDir) throw new Error("This worker has no directory for uploads");
  const dir = join(ctx.uploadsDir, ctx.worktreeId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = Date.now();
  const saved: NonNullable<ChatMessage["files"]> = [];
  for (const [i, part] of raw.entries()) {
    const p = part as { url?: unknown; mediaType?: unknown; filename?: unknown };
    const data = typeof p.url === "string" ? p.url.match(/^data:[^;]+;base64,(.+)$/) : null;
    if (!data) continue;
    const filename = typeof p.filename === "string" ? p.filename : undefined;
    const storedName = `${stamp}-${i}-${(filename || `file-${stamp}`).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const path = join(dir, storedName);
    await writeFile(path, Buffer.from(data[1], "base64"), { flag: "wx", mode: 0o600 });
    saved.push({
      path,
      mediaType: typeof p.mediaType === "string" ? p.mediaType : "application/octet-stream",
      url: `/api/uploads/${encodeURIComponent(ctx.worktreeId)}/${encodeURIComponent(storedName)}`,
      filename,
    });
  }
  return saved;
}

function history(owner: ChatOwner, chatId: string, url: URL) {
  const empty = { events: [], hasOlder: false, oldestEventId: 0 };
  const before = parseIntOrUndefined(url.searchParams.get("before"));
  const sessionId = owner.activeSessionId(chatId);
  if (!before || before <= 0 || !sessionId) return empty;
  const revision = owner.logRevision(sessionId);
  const clientRevision = parseIntOrUndefined(url.searchParams.get("revision"));
  if (revision === 0 || (clientRevision !== undefined && clientRevision !== revision)) return empty;
  return owner.replayTurns(sessionId, revision, HISTORY_PAGE_SIZE, before);
}

/**
 * The chat's event stream: the same frames, order and replay window as the
 * hub's `GET /api/chats/:chatId/events`, read from this worker's log.
 */
async function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatRouteContext,
  chatId: string,
  url: URL,
): Promise<void> {
  const { owner } = ctx;
  const cursor =
    parseIntOrUndefined(req.headers["last-event-id"]) ??
    parseIntOrUndefined(url.searchParams.get("lastEventId"));
  const clientRevision = parseIntOrUndefined(url.searchParams.get("revision"));

  for (const [key, value] of Object.entries(ctx.headers)) res.setHeader(key, value);
  const writer: SseWriter = openSseStream(res);
  let syntheticId = -1;
  const sessionId = owner.activeSessionId(chatId);
  const revision = sessionId ? owner.logRevision(sessionId) : 0;
  const reset = cursor !== undefined && clientRevision !== undefined && clientRevision !== revision;
  const cold = cursor === undefined || reset;

  writer.write({
    type: "subscription-opened",
    sessionId,
    revision,
    taskRunning: owner.taskRunning(chatId),
    reset,
    eventId: syntheticId--,
  });
  writer.write({ type: "queue-updated", messages: owner.queue(chatId), eventId: syntheticId-- });

  const queue: ChatEvent[] = [];
  let notify: (() => void) | null = null;
  let lastSent = cold ? 0 : (cursor ?? 0);
  const send = (event: ChatEvent) => {
    if (event.eventId > 0) {
      if (event.eventId <= lastSent) return;
      lastSent = event.eventId;
    } else if (event.eventId === -1 && event.type === "queue-updated") {
      // The owner's queue snapshots carry no id of their own here.
      writer.write({ ...event, eventId: syntheticId-- });
      return;
    }
    writer.write(event);
  };
  const unsubscribe = owner.subscribe(chatId, (event) => {
    queue.push(event);
    notify?.();
  });
  const onClose = () => notify?.();
  res.on("close", onClose);

  try {
    writer.write({
      type: "session-state",
      state: await owner.sessionState(chatId),
      eventId: syntheticId--,
    });
    if (sessionId && revision > 0) {
      if (cold) {
        const page = owner.replayTurns(sessionId, revision, HISTORY_PAGE_SIZE);
        for (const event of page.events) send(event);
        writer.write({
          type: "history-meta",
          hasOlder: page.hasOlder,
          oldestEventId: page.oldestEventId,
          eventId: syntheticId--,
        });
      } else {
        for (const event of owner.replayAfter(sessionId, revision, cursor ?? 0)) send(event);
      }
    } else if (cold) {
      writer.write({
        type: "history-meta",
        hasOlder: false,
        oldestEventId: 0,
        eventId: syntheticId--,
      });
    }

    while (!res.destroyed && !writer.closed) {
      while (queue.length > 0) {
        const event = queue.shift() as ChatEvent;
        send(event);
        // A turn ended with nothing queued behind it: close, as the hub does.
        if (
          event.type === "turn-ended" &&
          !owner.taskRunning(chatId) &&
          owner.queue(chatId).length === 0
        ) {
          return;
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
    writer.close();
  }
}
