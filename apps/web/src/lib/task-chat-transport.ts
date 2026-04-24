import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { trpc } from "./trpc-client";

function subscriptionToStream(
  workspaceId: string,
  chatId: string,
  opts?: {
    sessionId?: string;
    afterEventId?: number;
    abortSignal?: AbortSignal;
  },
): ReadableStream<UIMessageChunk> {
  let subscription: { unsubscribe: () => void } | null = null;
  let closed = false;

  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      subscription = trpc.tasks.stream.subscribe(
        {
          workspaceId,
          chatId,
          ...(opts?.sessionId && { sessionId: opts.sessionId }),
          ...(opts?.afterEventId != null && { afterEventId: opts.afterEventId }),
        },
        {
          onData(chunk: UIMessageChunk) {
            if (!closed) {
              try {
                controller.enqueue(chunk);
              } catch {
                closed = true;
              }
            }
          },
          onComplete() {
            console.log("[stream] subscription completed");
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // already closed by consumer or abort
              }
            }
          },
          onError(err: unknown) {
            console.error("[stream] subscription error:", err);
            if (!closed) {
              closed = true;
              try {
                controller.error(err);
              } catch {
                // already closed/errored
              }
            }
          },
        },
      );

      opts?.abortSignal?.addEventListener("abort", () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
        subscription?.unsubscribe();
      });
    },
    cancel() {
      closed = true;
      subscription?.unsubscribe();
    },
  });
}

export class TaskChatTransport implements ChatTransport<UIMessage> {
  private workspaceId: string;
  private chatId: string;
  private getSessionId: () => string | undefined;
  private getLastEventId: () => number | undefined;
  mode: string | undefined;
  model: string | undefined;
  codingAgentId: string | undefined;

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

  abort(): Promise<void> {
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

    // Submit the task
    try {
      await trpc.tasks.submit.mutate({
        workspaceId: this.workspaceId,
        chatId: this.chatId,
        prompt: userText,
        sessionId: this.getSessionId(),
        ...(files.length > 0 && { files }),
        ...(this.mode && { mode: this.mode }),
        ...(this.model && { model: this.model }),
        ...(this.codingAgentId && { codingAgentId: this.codingAgentId }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Submit failed";
      // If a task is already running (race condition — the pre-check in
      // handleSubmit passed but a task started before submit), queue the
      // message instead of failing.
      if (msg.includes("already running") || msg.includes("CONFLICT")) {
        await trpc.queue.push.mutate({
          workspaceId: this.workspaceId,
          chatId: this.chatId,
          text: userText,
        });
        return new ReadableStream<UIMessageChunk>({
          start(controller) {
            controller.close();
          },
        });
      }
      throw new Error(msg);
    }

    return subscriptionToStream(this.workspaceId, this.chatId, {
      sessionId: this.getSessionId(),
      abortSignal,
    });
  }

  async reconnectToStream(
    _options: Parameters<ChatTransport<UIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const task = await trpc.tasks.get.query({
      workspaceId: this.workspaceId,
      chatId: this.chatId,
    });
    if (!task.task || task.task.status !== "running") return null;

    const sessionId = this.getSessionId();
    const afterEventId = this.getLastEventId();
    console.log("[reconnect] opening stream", {
      sessionId,
      afterEventId,
      taskSessionId: task.task.sessionId,
    });
    console.trace("[reconnect] call stack");
    return subscriptionToStream(this.workspaceId, this.chatId, {
      sessionId,
      afterEventId,
    });
  }
}
