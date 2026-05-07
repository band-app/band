import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { parseJsonEventStream, uiMessageChunkSchema } from "ai";
import { trpc } from "./trpc-client";

/**
 * Parse a raw SSE byte stream into a stream of UIMessageChunk objects.
 *
 * Unlike the AI SDK's DefaultChatTransport (which throws on parse failures),
 * we silently skip chunks that don't match `uiMessageChunkSchema`. The task
 * runner broadcasts application-level chunks (e.g. "user-message") that are
 * not part of the standard UIMessageChunk union — these must not crash the
 * stream.
 */
function parseSSEStream(stream: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  return parseJsonEventStream({
    stream,
    schema: uiMessageChunkSchema,
  }).pipeThrough(
    new TransformStream<
      { success: boolean; value?: UIMessageChunk; error?: unknown },
      UIMessageChunk
    >({
      transform(chunk, controller) {
        if (!chunk.success) {
          // Skip non-standard chunks (e.g. "user-message") that fail schema
          // validation — these are internal application events, not UI stream
          // protocol chunks.
          return;
        }
        controller.enqueue(chunk.value!);
      },
    }),
  );
}

export class TaskChatTransport implements ChatTransport<UIMessage> {
  private workspaceId: string;
  private chatId: string;
  private getSessionId: () => string | undefined;
  private getLastEventId: () => number | undefined;
  mode: string | undefined;
  model: string | undefined;
  codingAgentId: string | undefined;

  /**
   * Internal AbortController for the current SSE fetch connection.
   * Used to close connections that the AI SDK can't abort (reconnectToStream
   * has no abortSignal in the ChatTransport interface).
   */
  private connectionController: AbortController | null = null;

  constructor(
    workspaceId: string,
    chatId: string,
    getSessionId: () => string | undefined,
    getLastEventId: () => number | undefined,
  ) {
    this.workspaceId = workspaceId;
    this.chatId = chatId;
    this.getSessionId = getSessionId;
    this.getLastEventId = getLastEventId;
  }

  /**
   * Abort any in-flight SSE connection. Called before opening a new one
   * to ensure at most one connection per transport instance.
   */
  private abortConnection(): void {
    if (this.connectionController) {
      this.connectionController.abort();
      this.connectionController = null;
    }
  }

  /**
   * Close the current SSE connection without aborting the server-side task.
   * Call this from component cleanup (unmount, tab deactivation) to release
   * the HTTP connection back to the browser's pool.
   */
  close(): void {
    this.abortConnection();
  }

  abort(): Promise<void> {
    this.abortConnection();
    return trpc.tasks.abort.mutate({ workspaceId: this.workspaceId, chatId: this.chatId }).then(
      () => {},
      () => {},
    );
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    // Close any existing reconnect/stream connection
    this.abortConnection();

    // Extract user text and files from the last message
    const lastMessage = messages[messages.length - 1];
    let userText = "";
    const files: { mediaType: string; url: string; filename?: string }[] = [];
    if (lastMessage) {
      for (const part of lastMessage.parts) {
        if (part.type === "text") {
          userText += part.text;
        } else if (part.type === "file") {
          const filePart = part as {
            type: "file";
            mediaType: string;
            url: string;
            filename?: string;
          };
          files.push({
            mediaType: filePart.mediaType,
            url: filePart.url,
            filename: filePart.filename,
          });
        }
      }
    }

    // Create a combined abort controller — aborts when either the SDK's
    // signal fires (stop()) or our internal close() is called.
    this.connectionController = new AbortController();
    const controller = this.connectionController;
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    // POST to the SSE endpoint — submits the task and opens a stream in one request
    const response = await fetch(`/api/tasks/${encodeURIComponent(this.chatId)}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: this.workspaceId,
        prompt: userText,
        sessionId: this.getSessionId(),
        ...(files.length > 0 && { files }),
        ...(this.mode && { mode: this.mode }),
        ...(this.model && { model: this.model }),
        ...(this.codingAgentId && { codingAgentId: this.codingAgentId }),
      }),
      signal: controller.signal,
    });

    // Handle conflict — task is already running, queue the message instead.
    // Files are queued as base64 data URLs (same shape sent above) so the
    // task-runner can upload them when the queued message is drained.
    if (response.status === 409) {
      await trpc.queue.push.mutate({
        workspaceId: this.workspaceId,
        chatId: this.chatId,
        text: userText,
        ...(files.length > 0 && { files }),
      });
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.close();
        },
      });
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: "Stream request failed" }));
      throw new Error((err as { error?: string }).error || `HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("The response body is empty.");
    }

    return parseSSEStream(response.body);
  }

  async reconnectToStream(
    _options: Parameters<ChatTransport<UIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // Close any existing connection before reconnecting
    this.abortConnection();

    const sessionId = this.getSessionId();
    const lastEventId = this.getLastEventId();

    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);

    this.connectionController = new AbortController();

    const headers: Record<string, string> = {};
    if (lastEventId != null) {
      headers["Last-Event-ID"] = String(lastEventId);
    }

    let response: Response;
    try {
      response = await fetch(
        `/api/tasks/${encodeURIComponent(this.chatId)}/stream?${params.toString()}`,
        { method: "GET", headers, signal: this.connectionController.signal },
      );
    } catch (err) {
      // AbortError from close() — not a real failure
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }

    // 204 = no active stream to reconnect to
    if (response.status === 204) return null;

    if (!response.ok) {
      throw new Error(`Reconnect failed: HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("The response body is empty.");
    }

    return parseSSEStream(response.body);
  }
}
