import type { CanUseTool, SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { getSessionMessages, listSessions, query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "@band/logger";
import type { ClaudeCodeConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import type {
  CodingAgent,
  SessionListItem,
  SessionMessageItem,
  UserInputRequest,
} from "../types.js";

const log = createLogger("coding-agent:claude-code");

const ASK_USER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function formatUserAnswer(answers: Record<string, string>): string {
  const lines = Object.entries(answers).map(([question, answer]) => `${question}: ${answer}`);
  return `The user selected:\n${lines.join("\n")}`;
}

export class ClaudeCodeAdapter implements CodingAgent {
  readonly name = "Claude Code";
  readonly supportedFeatures = {
    costTracking: true,
    sessionListing: true,
  } as const;

  onUserInputNeeded?: (request: UserInputRequest) => Promise<Record<string, string>>;

  private readonly workspaceDir: string;
  private readonly maxTurns: number;
  private readonly model: string | undefined;
  private readonly executablePath: string | undefined;
  private readonly additionalDirectories: string[] | undefined;
  private activeConversation: ReturnType<typeof query> | null = null;

  constructor(config: ClaudeCodeConfig) {
    this.workspaceDir = config.workspaceDir;
    this.maxTurns = config.maxTurns;
    this.model = config.options.model;
    this.executablePath = config.options.executablePath;
    this.additionalDirectories = config.additionalDirectories;
  }

  abort(): void {
    if (this.activeConversation) {
      log.info("aborting active conversation");
      this.activeConversation.close();
      this.activeConversation = null;
    }
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

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      if (toolName !== "AskUserQuestion" || !this.onUserInputNeeded) {
        return { behavior: "allow", updatedInput: input };
      }

      const approvalId = options.toolUseID;
      log.info(
        { toolName, approvalId, toolUseID: options.toolUseID },
        "AskUserQuestion intercepted",
      );

      try {
        const answers = await Promise.race([
          this.onUserInputNeeded({
            approvalId,
            toolCallId: options.toolUseID,
            toolName,
            input: input as Record<string, unknown>,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("User input timeout")), ASK_USER_QUESTION_TIMEOUT_MS),
          ),
        ]);

        return { behavior: "deny", message: formatUserAnswer(answers) };
      } catch (err) {
        log.warn({ err, approvalId }, "AskUserQuestion timed out or errored, auto-allowing");
        return { behavior: "allow", updatedInput: input };
      }
    };

    const conversation = query({
      prompt,
      options: {
        cwd: this.workspaceDir,
        model: this.model,
        maxTurns: this.maxTurns,
        resume: sessionId,
        canUseTool,
        env,
        additionalDirectories: this.additionalDirectories,
        pathToClaudeCodeExecutable: this.executablePath,
        settingSources: ["user", "project"],
        stderr: (data) => log.warn({ data }, "claude-code stderr"),
      },
    });

    this.activeConversation = conversation;
    log.info("query() called, waiting for messages...");

    const state: ProcessedState = {
      assistantContentIndex: 0,
      toolNames: new Map(),
      hasEmittedTextSinceLastUser: false,
    };

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
      this.activeConversation = null;
      log.info("closing conversation");
      conversation.close();
    }
  }

  async listSessions(dir: string): Promise<SessionListItem[]> {
    log.info({ dir }, "listSessions");
    const sessions = await listSessions({ dir, limit: 50 });
    return sessions.filter((s) => s.cwd === dir).map(mapSessionInfo);
  }

  async getSessionMessages(
    sessionId: string,
    dir: string,
    options?: { limit?: number; offset?: number },
  ): Promise<SessionMessageItem[]> {
    log.info({ sessionId, dir, ...options }, "getSessionMessages");
    const messages = await getSessionMessages(sessionId, {
      dir,
      limit: options?.limit,
      offset: options?.offset,
    });
    return messages.map(mapSessionMessage);
  }
}

function mapSessionInfo(info: SDKSessionInfo): SessionListItem {
  return {
    sessionId: info.sessionId,
    summary: info.customTitle ?? info.summary ?? info.firstPrompt ?? "Untitled session",
    lastModified: info.lastModified,
    firstPrompt: info.firstPrompt,
    gitBranch: info.gitBranch,
  };
}

function mapSessionMessage(msg: SessionMessage): SessionMessageItem {
  const content: SessionMessageItem["content"] = [];
  const raw = msg.message as {
    content?:
      | string
      | Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
  } | null;

  if (typeof raw?.content === "string") {
    if (raw.content.trim()) {
      content.push({ type: "text", text: raw.content });
    }
  } else if (raw?.content && Array.isArray(raw.content)) {
    for (const block of raw.content) {
      if (block.type === "text" && block.text) {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          toolCallId: block.id ?? "",
          toolName: block.name ?? "unknown",
          input: block.input ?? {},
        });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        const output =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        content.push({
          type: "tool_result",
          toolCallId: block.tool_use_id,
          output,
          isError: block.is_error ?? false,
        });
      }
    }
  }

  return {
    role: msg.type,
    id: msg.uuid,
    content,
  };
}

interface ProcessedState {
  assistantContentIndex: number;
  toolNames: Map<string, string>;
  hasEmittedTextSinceLastUser: boolean;
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

        let processedUpTo = startIdx;
        for (let i = startIdx; i < content.length; i++) {
          const block = content[i];
          if (block.type === "text") {
            if (!block.text) {
              // Text block exists but content hasn't streamed yet;
              // don't advance past it so we re-process on the next event.
              break;
            }
            yield { type: "text-delta", text: block.text };
            state.hasEmittedTextSinceLastUser = true;
            processedUpTo = i + 1;
          } else if (block.type === "tool_use") {
            const toolCallId = block.id ?? crypto.randomUUID();
            const toolName = block.name ?? "unknown";
            state.toolNames.set(toolCallId, toolName);
            yield {
              type: "tool-use",
              toolCallId,
              toolName,
              input: block.input ?? {},
            };
            processedUpTo = i + 1;
          } else {
            processedUpTo = i + 1;
          }
        }

        state.assistantContentIndex = processedUpTo;
      }
      break;
    }

    case "user": {
      state.assistantContentIndex = 0;
      state.hasEmittedTextSinceLastUser = false;
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
              toolName: state.toolNames.get(block.tool_use_id),
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

      // Fallback: if the final assistant text was never streamed via
      // intermediate `assistant` events (e.g. the SDK jumped straight
      // from an empty-text placeholder to the `result` event), emit
      // the text carried on the result payload so it reaches the UI.
      if (subtype === "success" && !state.hasEmittedTextSinceLastUser) {
        const resultText = message.result as string | undefined;
        if (resultText) {
          log.info("emitting result text as fallback (text was not streamed)");
          yield { type: "text-delta", text: resultText };
        }
      }

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
