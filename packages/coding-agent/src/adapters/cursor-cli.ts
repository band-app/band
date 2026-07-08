import { createLogger } from "@band-app/logger";
import { CursorAgent } from "@nothumanwork/cursor-agents-sdk";
import type { CursorCliConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import type { AgentModel, CliInvocation, CodingAgent, RunSessionOptions } from "../types.js";

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

  private readonly model: string;
  private activeIterator: AsyncIterator<unknown> | null = null;

  constructor(config: CursorCliConfig) {
    this.model = config.options.model;
  }

  abort(): void {
    if (this.activeIterator) {
      log.info("aborting active cursor stream");
      this.activeIterator.return?.(undefined);
      this.activeIterator = null;
    }
  }

  async *runSession(
    prompt: string,
    sessionId?: string,
    options?: RunSessionOptions,
  ): AsyncGenerator<AgentEvent> {
    const effectiveModel = options?.model ?? this.model;

    log.info(
      {
        prompt: prompt.slice(0, 100),
        sessionId,
        model: effectiveModel,
      },
      "runSession starting",
    );

    const agent = new CursorAgent({
      defaultModel: effectiveModel,
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

  listModels(): AgentModel[] {
    return CURSOR_MODELS;
  }

  /**
   * Cursor CLI doesn't expose a `models` listing command, so the live
   * list IS the hardcoded `CURSOR_MODELS` array. Returning it here makes
   * `ModelRefreshService.refresh()` Just Work — the persisted cache lines
   * up with whatever the adapter would otherwise serve from `listModels()`.
   */
  async refreshModels(): Promise<AgentModel[]> {
    return CURSOR_MODELS;
  }

  /**
   * Cursor CLI does not currently expose a one-shot interactive REPL
   * invocation that accepts an initial prompt as a positional argument
   * (the SDK transport is JSON over a managed subprocess). For
   * `workspaces.create --via terminal` (issue #551) we return the
   * `unsupported` sentinel so the workspace service falls back to the
   * SDK/chat path instead of spawning a terminal that would just open a
   * shell prompt with the user's text echoed at it.
   */
  cliInvocation(_prompt: string): CliInvocation {
    return {
      unsupported: true,
      reason: "Cursor CLI has no interactive prompt-loading invocation; falling back to chat.",
    };
  }

  /**
   * Cursor CLI is SDK-only (JSON over a managed subprocess) with no
   * non-interactive vendor CLI to run in a pane, so headless terminal
   * dispatch (cronjobs `via: "terminal"`, issue #581) also returns the
   * `unsupported` sentinel — the cronjob service then falls back to chat.
   */
  cliHeadlessInvocation(_prompt: string): CliInvocation {
    return {
      unsupported: true,
      reason: "Cursor CLI has no non-interactive CLI invocation; falling back to chat.",
    };
  }

  /**
   * The chat tab's "Continue in terminal" action has no Cursor equivalent:
   * the agent runs over the SDK's managed JSON subprocess, with no
   * interactive by-id resume CLI. Returning the `unsupported` sentinel
   * keeps the menu item disabled.
   */
  resumeCliInvocation(_sessionId: string): CliInvocation {
    return {
      unsupported: true,
      reason: "Cursor CLI has no interactive session-resume invocation.",
    };
  }
}

/**
 * Cursor "auto" routes among multiple backends — context window varies by
 * the chosen model. No SDK-side reporting; leaving contextWindow undefined
 * lets the meter fall back to the static MODEL_CONTEXT_WINDOWS default.
 */
const CURSOR_MODELS: AgentModel[] = [
  { id: "auto", name: "Auto", description: "Cursor chooses the best model" },
];

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
          toolName: resolveToolName(toolCall),
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
