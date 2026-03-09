import { createLogger } from "@band/logger";
import { CursorAgent } from "@nothumanwork/cursor-agents-sdk";
import type { CursorCliConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import type { CodingAgent } from "../types.js";

const log = createLogger("coding-agent:cursor-cli");

const TOOL_NAME_MAP: Record<string, string> = {
  readToolCall: "Read",
  writeToolCall: "Write",
  shellToolCall: "Bash",
  editToolCall: "Edit",
  globToolCall: "Glob",
  grepToolCall: "Grep",
};

function resolveToolName(toolCall: Record<string, unknown>): string {
  for (const [key, name] of Object.entries(TOOL_NAME_MAP)) {
    if (key in toolCall) return name;
  }
  const fn =
    (toolCall.functionCall as Record<string, unknown>) ??
    (toolCall.function as Record<string, unknown>);
  if (fn?.name) return fn.name as string;
  return "unknown";
}

function resolveToolInput(toolCall: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(TOOL_NAME_MAP)) {
    const entry = toolCall[key] as Record<string, unknown> | undefined;
    if (entry?.args) return entry.args as Record<string, unknown>;
  }
  const fn =
    (toolCall.functionCall as Record<string, unknown>) ??
    (toolCall.function as Record<string, unknown>);
  if (fn?.arguments) {
    const args = fn.arguments;
    if (typeof args === "string") {
      try {
        return JSON.parse(args);
      } catch {
        return { raw: args };
      }
    }
    return args as Record<string, unknown>;
  }
  return {};
}

export class CursorCliAdapter implements CodingAgent {
  readonly name = "Cursor CLI";
  readonly supportedFeatures = {
    costTracking: false,
    sessionListing: false,
  } as const;

  private readonly maxTurns: number;
  private readonly model: string;
  private activeIterator: AsyncIterator<unknown> | null = null;

  constructor(config: CursorCliConfig) {
    this.maxTurns = config.maxTurns;
    this.model = config.options.model;
  }

  abort(): void {
    if (this.activeIterator) {
      log.info("aborting active cursor stream");
      this.activeIterator.return?.(undefined);
      this.activeIterator = null;
    }
  }

  async *runSession(prompt: string, sessionId?: string): AsyncGenerator<AgentEvent> {
    log.info(
      {
        prompt: prompt.slice(0, 100),
        sessionId,
        model: this.model,
        maxTurns: this.maxTurns,
      },
      "runSession starting",
    );

    const agent = new CursorAgent({
      defaultModel: this.model,
      forceWrites: true,
    });

    const stream = agent.stream({
      prompt,
      chatId: sessionId,
      streamPartialOutput: true,
    });

    let turnCount = 0;
    const startMs = Date.now();
    let lastAssistantText = "";

    const iterator = stream[Symbol.asyncIterator]();
    this.activeIterator = iterator;

    try {
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
        const type = event.type as string;
        log.debug(
          {
            eventType: type,
            subtype: "subtype" in event ? event.subtype : undefined,
          },
          "cursor event",
        );

        yield* mapCursorEvent(
          event as Record<string, unknown>,
          type,
          startMs,
          turnCount,
          lastAssistantText,
        );

        if (type === "assistant") {
          const msg = (
            event as {
              message?: {
                content?: Array<{
                  type: string;
                  text?: string;
                }>;
              };
            }
          ).message;
          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                lastAssistantText = block.text;
              }
            }
          }
        }

        if (type === "tool_call" && (event as { subtype?: string }).subtype === "started") {
          turnCount++;
        }
      }
      log.info("cursor stream done");
    } catch (err) {
      log.error({ err }, "cursor error");
      throw err;
    } finally {
      this.activeIterator = null;
    }
  }
}

function* mapCursorEvent(
  event: Record<string, unknown>,
  type: string,
  startMs: number,
  turnCount: number,
  lastAssistantText: string,
): Generator<AgentEvent> {
  const subtype = event.subtype as string | undefined;

  switch (type) {
    case "system": {
      if (subtype === "init" && event.session_id) {
        yield {
          type: "session-start",
          sessionId: String(event.session_id),
        };
      }
      break;
    }

    case "assistant": {
      const msg = (
        event as {
          message?: {
            content?: Array<{ type: string; text?: string }>;
          };
        }
      ).message;
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            let delta: string;
            if (block.text.startsWith(lastAssistantText)) {
              delta = block.text.slice(lastAssistantText.length);
            } else {
              delta = block.text;
            }
            if (delta) {
              yield { type: "text-delta", text: delta };
            }
          }
        }
      }
      break;
    }

    case "tool_call": {
      const callId = event.call_id as string | undefined;
      const toolCall = event.tool_call as Record<string, unknown> | undefined;
      if (!toolCall || !callId) break;

      if (subtype === "started") {
        yield {
          type: "tool-use",
          toolCallId: callId,
          toolName: resolveToolName(toolCall),
          input: resolveToolInput(toolCall),
        };
      } else if (subtype === "completed") {
        const result = toolCall.result as
          | {
              success?: { content?: string };
              error?: { message?: string };
            }
          | undefined;
        const isError = !!result?.error;
        const output = isError
          ? (result?.error?.message ?? "Tool error")
          : (result?.success?.content ?? "");
        yield {
          type: "tool-result",
          toolCallId: callId,
          output,
          isError,
        };
      }
      break;
    }

    case "result": {
      const sid = String(event.session_id ?? "");
      const durationMs = (event.duration_ms as number) ?? Date.now() - startMs;

      if (subtype === "success") {
        yield {
          type: "session-result",
          success: true,
          sessionId: sid,
          durationMs,
          numTurns: turnCount,
          costUsd: 0,
          errors: [],
        };
      } else {
        const resultText = event.result as string | undefined;
        yield {
          type: "session-result",
          success: false,
          sessionId: sid,
          durationMs,
          numTurns: turnCount,
          costUsd: 0,
          errors: [resultText ?? `Cursor agent error (${subtype})`],
        };
      }
      break;
    }
  }
}
