import type { CodingAgent } from "@band/coding-agent";
import { createLogger } from "@band/logger";
import type { UIMessageStreamWriter } from "ai";

const log = createLogger("stream-writer");

const MAX_TOOL_OUTPUT_LEN = 10_000;

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_LEN) return output;
  return `${output.slice(0, MAX_TOOL_OUTPUT_LEN)}\n\n[output truncated — ${output.length} chars total]`;
}

export async function writeAgentStream(
  agent: CodingAgent,
  text: string,
  sessionId: string | undefined,
  writer: UIMessageStreamWriter,
): Promise<void> {
  let textPartId = "";
  let textStarted = false;
  let finished = false;
  const announcedToolCalls = new Set<string>();

  try {
    for await (const event of agent.runSession(text, sessionId)) {
      log.info({ eventType: event.type }, "stream event");

      switch (event.type) {
        case "session-start": {
          writer.write({
            type: "data-session" as const,
            data: { sessionId: event.sessionId },
          });
          break;
        }

        case "text-delta": {
          if (!textStarted) {
            textPartId = crypto.randomUUID();
            writer.write({
              type: "text-start",
              id: textPartId,
            });
            textStarted = true;
          }
          writer.write({
            type: "text-delta",
            id: textPartId,
            delta: event.text,
          });
          break;
        }

        case "tool-use": {
          if (textStarted) {
            writer.write({ type: "text-end", id: textPartId });
            textStarted = false;
          }
          announcedToolCalls.add(event.toolCallId);
          writer.write({
            type: "tool-input-available",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
          });
          break;
        }

        case "tool-result": {
          if (!announcedToolCalls.has(event.toolCallId)) {
            if (textStarted) {
              writer.write({ type: "text-end", id: textPartId });
              textStarted = false;
            }
            writer.write({
              type: "tool-input-available",
              toolCallId: event.toolCallId,
              toolName: "tool",
              input: {},
            });
            announcedToolCalls.add(event.toolCallId);
          }
          const truncated = truncateToolOutput(event.output);
          writer.write({
            type: "tool-output-available",
            toolCallId: event.toolCallId,
            output: truncated,
          });
          break;
        }

        case "session-result": {
          if (textStarted) {
            writer.write({ type: "text-end", id: textPartId });
            textStarted = false;
          }

          if (event.success) {
            writer.write({
              type: "data-result" as const,
              data: {
                sessionId: event.sessionId,
                durationMs: event.durationMs,
                numTurns: event.numTurns,
                ...(agent.supportedFeatures.costTracking && {
                  costUsd: event.costUsd,
                }),
              },
            });
            writer.write({ type: "finish-step" });
            writer.write({ type: "finish" });
            finished = true;
          } else {
            writer.write({
              type: "error",
              errorText: `Agent error: ${event.errors.join(", ") || "unknown error"}`,
            });
            finished = true;
          }
          break;
        }

        case "error": {
          writer.write({
            type: "error",
            errorText: event.message,
          });
          break;
        }
      }
    }

    if (textStarted) {
      writer.write({ type: "text-end", id: textPartId });
    }

    if (!finished) {
      writer.write({
        type: "error",
        errorText: "Agent session ended without producing a result",
      });
    }
  } catch (err) {
    writer.write({
      type: "error",
      errorText: err instanceof Error ? err.message : "Unknown error",
    });
  }
}
