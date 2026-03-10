import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { trpc } from "./trpc-client";

function parseSSEStream(body: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          // Keep the last incomplete line in the buffer
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const json = line.slice(6);
              try {
                const chunk = JSON.parse(json) as UIMessageChunk;
                controller.enqueue(chunk);
              } catch {
                // ignore parse errors
              }
            }
            // skip keepalive comments and empty lines
          }
        }
        // Process any remaining data in buffer
        if (buffer.startsWith("data: ")) {
          const json = buffer.slice(6);
          try {
            const chunk = JSON.parse(json) as UIMessageChunk;
            controller.enqueue(chunk);
          } catch {
            // ignore
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
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

  abort(): void {
    trpc.tasks.abort.mutate({ workspaceId: this.workspaceId }).catch(() => {
      // fire-and-forget
    });
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

    // Open SSE stream to receive UIMessageChunk
    const streamRes = await fetch(`/api/tasks/${encodeURIComponent(this.workspaceId)}/stream`, {
      signal: abortSignal,
    });

    if (!streamRes.ok || !streamRes.body) {
      throw new Error(`Stream failed: ${streamRes.status}`);
    }

    return parseSSEStream(streamRes.body);
  }

  async reconnectToStream(
    _options: Parameters<ChatTransport<UIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const res = await fetch(`/api/tasks/${encodeURIComponent(this.workspaceId)}/stream`);

    if (res.status === 204) {
      return null;
    }

    if (!res.ok || !res.body) {
      return null;
    }

    return parseSSEStream(res.body);
  }
}
