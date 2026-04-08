import type { UIMessage } from "ai";
import type { SessionEventRecord } from "./session-store";

type UIMessageParts = UIMessage["parts"];

// ---------------------------------------------------------------------------
// Convert in-memory stream chunks (SessionEventRecord) → UIMessage[]
// ---------------------------------------------------------------------------

/**
 * Replay a sequence of buffered session event chunks into UIMessage[].
 *
 * This reconstructs the same message structure that the live stream produces
 * in the useChat hook — text parts are assembled from text-start/delta/end,
 * tool parts from tool-input-available/tool-output-available, etc.
 */
export function convertEventsToUIMessages(events: SessionEventRecord[]): UIMessage[] {
  const messages: UIMessage[] = [];
  let currentAssistant: UIMessage | null = null;
  let currentTextId: string | null = null;
  let currentTextContent = "";

  function flushText() {
    if (currentTextId && currentTextContent && currentAssistant) {
      currentAssistant.parts.push({
        type: "text",
        text: currentTextContent,
      });
      currentTextId = null;
      currentTextContent = "";
    }
  }

  function ensureAssistant(): UIMessage {
    if (!currentAssistant) {
      currentAssistant = {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [] as UIMessageParts,
      };
      messages.push(currentAssistant);
    }
    return currentAssistant;
  }

  for (const event of events) {
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(event.chunkJson);
    } catch {
      continue;
    }

    switch (chunk.type) {
      case "text-start": {
        ensureAssistant();
        currentTextId = chunk.id as string;
        currentTextContent = "";
        break;
      }

      case "text-delta": {
        ensureAssistant();
        if (chunk.id === currentTextId) {
          currentTextContent += chunk.delta as string;
        }
        break;
      }

      case "text-end": {
        flushText();
        break;
      }

      case "tool-input-available": {
        flushText();
        const msg = ensureAssistant();
        msg.parts.push({
          type: "dynamic-tool",
          toolName: chunk.toolName as string,
          toolCallId: chunk.toolCallId as string,
          state: "input-available",
          input: chunk.input,
          ...(chunk.title ? { title: chunk.title as string } : {}),
        } as UIMessageParts[number]);
        break;
      }

      case "tool-output-available": {
        const msg = ensureAssistant();
        // Find the matching tool part and update its state
        const toolPart = msg.parts.find(
          (p) =>
            "toolCallId" in p &&
            p.toolCallId === (chunk.toolCallId as string) &&
            p.type === "dynamic-tool",
        );
        if (toolPart) {
          const tp = toolPart as Record<string, unknown>;
          tp.state = "output-available";
          tp.output = chunk.output;
        }
        break;
      }

      case "user-message": {
        // Initial user prompt — broadcast at task start so the buffer
        // includes the user message (not just assistant chunks).
        flushText();
        currentAssistant = null;
        messages.push({
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: chunk.text as string }],
        });
        break;
      }

      case "data-prompt": {
        // Queue boundary: finalize current assistant, insert user message
        flushText();
        currentAssistant = null;
        const data = chunk.data as { text: string };
        messages.push({
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: data.text }],
        });
        break;
      }

      case "file": {
        flushText();
        const msg = ensureAssistant();
        msg.parts.push({
          type: "file",
          mediaType: chunk.mediaType as string,
          url: chunk.url as string,
        } as UIMessageParts[number]);
        break;
      }

      case "error": {
        flushText();
        const msg = ensureAssistant();
        msg.parts.push({
          type: "text",
          text: `Error: ${chunk.errorText as string}`,
        });
        break;
      }

      case "data-session":
      case "data-result":
      case "finish-step":
      case "finish":
      case "start-step":
      case "start": {
        // Control events — no visible parts, but flush pending text
        flushText();
        break;
      }
    }
  }

  // Flush any remaining text
  flushText();

  return messages;
}

// ---------------------------------------------------------------------------
// Convert agent JSONL history (HistoryMessage[]) → UIMessage[]
// ---------------------------------------------------------------------------

interface HistoryMessageContent {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  displayTitle?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}

interface HistoryMessage {
  role: "user" | "assistant";
  id: string;
  content: HistoryMessageContent[];
}

/**
 * Convert agent session JSONL history messages into UIMessage[].
 * This is the server-side equivalent of the client's convertHistoryToUIMessages.
 */
export function convertHistoryToUIMessages(history: HistoryMessage[]): UIMessage[] {
  // Build a map of tool_result blocks keyed by toolCallId for quick lookup
  const toolResultMap = new Map<string, HistoryMessageContent>();
  for (const msg of history) {
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.toolCallId) {
        toolResultMap.set(block.toolCallId, block);
      }
    }
  }

  return history.map((msg) => {
    const parts: UIMessageParts = [];

    if (msg.role === "user") {
      const userText = msg.content
        .filter((b) => b.type === "text" && b.text?.trim())
        .map((b) => b.text!)
        .join("\n");

      if (userText) {
        parts.push({ type: "text", text: userText });
      }
    } else {
      // Assistant message
      for (const block of msg.content) {
        if (block.type === "text" && block.text?.trim()) {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          const callId = block.toolCallId ?? "";
          const toolName = block.toolName ?? "unknown";
          const title = block.displayTitle;
          const result = toolResultMap.get(callId);

          if (result?.isError) {
            parts.push({
              type: "dynamic-tool",
              toolName,
              toolCallId: callId,
              state: "output-error",
              input: block.input,
              errorText: result.output ?? "Error",
              ...(title ? { title } : {}),
            } as UIMessageParts[number]);
          } else if (result) {
            parts.push({
              type: "dynamic-tool",
              toolName,
              toolCallId: callId,
              state: "output-available",
              input: block.input,
              output: result.output,
              ...(title ? { title } : {}),
            } as UIMessageParts[number]);
          } else {
            parts.push({
              type: "dynamic-tool",
              toolName,
              toolCallId: callId,
              state: "input-available",
              input: block.input,
              ...(title ? { title } : {}),
            } as UIMessageParts[number]);
          }
        }
      }
    }

    return { id: msg.id, role: msg.role, parts };
  });
}
