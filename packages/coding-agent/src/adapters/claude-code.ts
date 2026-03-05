import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "@band/logger";
import type { ClaudeCodeConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import type { CodingAgent } from "../types.js";

const log = createLogger("coding-agent:claude-code");

export class ClaudeCodeAdapter implements CodingAgent {
  readonly name = "Claude Code";
  readonly supportedFeatures = {
    costTracking: true,
  } as const;

  private readonly workspaceDir: string;
  private readonly maxTurns: number;
  private readonly model: string | undefined;
  private readonly executablePath: string | undefined;

  constructor(config: ClaudeCodeConfig) {
    this.workspaceDir = config.workspaceDir;
    this.maxTurns = config.maxTurns;
    this.model = config.options.model;
    this.executablePath = config.options.executablePath;
  }

  async *runSession(prompt: string, sessionId?: string): AsyncGenerator<AgentEvent> {
    const env = { ...process.env };
    env.CLAUDECODE = undefined;
    env.CLAUDE_CODE_ENTRYPOINT = undefined;
    env.ANTHROPIC_CUSTOM_HEADERS = undefined;

    log.info(
      {
        prompt: prompt.slice(0, 100),
        sessionId,
        model: this.model,
        cwd: this.workspaceDir,
        maxTurns: this.maxTurns,
        claudeCodePath: this.executablePath || "(default)",
      },
      "runSession starting",
    );

    const conversation = query({
      prompt,
      options: {
        cwd: this.workspaceDir,
        model: this.model,
        maxTurns: this.maxTurns,
        resume: sessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env,
        pathToClaudeCodeExecutable: this.executablePath,
        settingSources: ["user", "project"],
        stderr: (data) => log.warn({ data }, "claude-code stderr"),
      },
    });

    log.info("query() called, waiting for messages...");

    const state: ProcessedState = { assistantContentIndex: 0 };

    try {
      for await (const message of conversation) {
        log.debug(
          {
            messageType: message.type,
            subtype: "subtype" in message ? message.subtype : undefined,
          },
          "sdk message",
        );

        yield* mapClaudeCodeEvent(message, state);
      }
      log.info("conversation generator done");
    } catch (err) {
      log.error({ err }, "conversation error");
      throw err;
    } finally {
      log.info("closing conversation");
      conversation.close();
    }
  }
}

interface ProcessedState {
  assistantContentIndex: number;
}

function* mapClaudeCodeEvent(
  message: Record<string, unknown>,
  state: ProcessedState,
): Generator<AgentEvent> {
  const type = message.type as string;
  const subtype = message.subtype as string | undefined;

  switch (type) {
    case "system": {
      if (subtype === "init" && message.session_id) {
        yield {
          type: "session-start",
          sessionId: String(message.session_id),
        };
      }
      break;
    }

    case "assistant": {
      const msg = message.message as
        | {
            content?: Array<{
              type: string;
              text?: string;
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
          }
        | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        let startIdx = state.assistantContentIndex;
        if (content.length < startIdx) {
          startIdx = 0;
        }

        for (let i = startIdx; i < content.length; i++) {
          const block = content[i];
          if (block.type === "text" && block.text) {
            yield { type: "text-delta", text: block.text };
          }
          if (block.type === "tool_use") {
            yield {
              type: "tool-use",
              toolCallId: block.id ?? crypto.randomUUID(),
              toolName: block.name ?? "unknown",
              input: block.input ?? {},
            };
          }
        }

        state.assistantContentIndex = content.length;
      }
      break;
    }

    case "user": {
      state.assistantContentIndex = 0;
      const msg = message.message as
        | {
            content?: Array<{
              type: string;
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
            }>;
          }
        | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const output =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content ?? "");

            yield {
              type: "tool-result",
              toolCallId: block.tool_use_id,
              output,
              isError: block.is_error ?? false,
            };
          }
        }
      }
      break;
    }

    case "result": {
      const sid = String(message.session_id ?? "");
      const durationMs = (message.duration_ms as number) ?? 0;
      const numTurns = (message.num_turns as number) ?? 0;
      const costUsd = (message.total_cost_usd as number) ?? 0;

      if (subtype === "success") {
        yield {
          type: "session-result",
          success: true,
          sessionId: sid,
          durationMs,
          numTurns,
          costUsd,
          errors: [],
        };
      } else {
        const errors = (message.errors as string[]) ?? [`Agent error (${subtype})`];
        yield {
          type: "session-result",
          success: false,
          sessionId: sid,
          durationMs,
          numTurns,
          costUsd,
          errors,
        };
      }
      break;
    }

    case "error": {
      yield {
        type: "error",
        message: "message" in message ? String(message.message) : "Unknown error",
      };
      break;
    }
  }
}
