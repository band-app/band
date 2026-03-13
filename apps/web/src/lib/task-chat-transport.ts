import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { trpc } from "./trpc-client";

function subscriptionToStream(
  workspaceId: string,
  abortSignal?: AbortSignal,
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      const subscription = trpc.tasks.stream.subscribe(
        { workspaceId },
        {
          onData(chunk: UIMessageChunk) {
            controller.enqueue(chunk);
          },
          onComplete() {
            controller.close();
          },
          onError(err: unknown) {
            controller.error(err);
          },
        },
      );

      abortSignal?.addEventListener("abort", () => {
        subscription.unsubscribe();
      });
    },
  });
}

export class TaskChatTransport implements ChatTransport<UIMessage> {
  private workspaceId: string;
  private getSessionId: () => string | undefined;

  constructor(workspaceId: string, getSessionId: () => string | undefined) {
    this.workspaceId = workspaceId;
    this.getSessionId = getSessionId;
  }

  abort(): Promise<void> {
    return trpc.tasks.abort.mutate({ workspaceId: this.workspaceId }).then(
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
        prompt: userText,
        sessionId: this.getSessionId(),
        ...(files.length > 0 && { files }),
      });
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "Submit failed");
    }

    return subscriptionToStream(this.workspaceId, abortSignal);
  }

  async reconnectToStream(
    _options: Parameters<ChatTransport<UIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // Check if there's an active task or buffered chunks
    const task = await trpc.tasks.get.query({ workspaceId: this.workspaceId });
    if (!task.task) return null;

    return subscriptionToStream(this.workspaceId);
  }
}
