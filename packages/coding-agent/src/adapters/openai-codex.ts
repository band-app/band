import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import type { OpenAICodexConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import { readSkillsFromDir } from "../skills.js";
import type { AgentModel, CodingAgent, RunSessionOptions, SkillInfo } from "../types.js";

const log = createLogger("coding-agent:openai-codex");

export class OpenAICodexAdapter implements CodingAgent {
  readonly name = "OpenAI Codex";
  readonly supportedFeatures = {
    costTracking: true,
    sessionListing: false,
  } as const;

  private readonly workspaceDir: string;
  private readonly maxTurns: number;
  private readonly model: string;
  private readonly sandboxMode: string;
  private activeIterator: AsyncIterator<unknown> | null = null;

  constructor(config: OpenAICodexConfig) {
    this.workspaceDir = config.workspaceDir;
    this.maxTurns = config.maxTurns;
    this.model = config.options.model ?? "codex-mini";
    this.sandboxMode = config.options.sandboxMode ?? "docker";
  }

  abort(): void {
    if (this.activeIterator) {
      log.info("aborting active codex stream");
      this.activeIterator.return?.(undefined);
      this.activeIterator = null;
    }
  }

  async *runSession(
    prompt: string,
    sessionId?: string,
    options?: RunSessionOptions,
  ): AsyncGenerator<AgentEvent> {
    const effectiveMaxTurns = options?.maxTurns ?? this.maxTurns;
    const effectiveModel = options?.model ?? this.model;

    log.info(
      {
        prompt: prompt.slice(0, 100),
        sessionId,
        model: effectiveModel,
        cwd: this.workspaceDir,
        maxTurns: effectiveMaxTurns,
      },
      "runSession starting",
    );

    const moduleName = ["@openai", "codex-sdk"].join("/");
    const sdk = (await import(moduleName)) as {
      Codex: new (opts: {
        model: string;
      }) => {
        startThread(): CodexThread;
        resumeThread(id: string): CodexThread;
      };
    };

    const codex = new sdk.Codex({ model: effectiveModel });

    const startMs = Date.now();
    let turnCount = 0;

    const thread = sessionId ? codex.resumeThread(sessionId) : codex.startThread();

    const stream = thread.runStreamed(prompt, {
      cwd: this.workspaceDir,
      maxTurns: effectiveMaxTurns,
      sandbox: this.sandboxMode,
    });

    const iterator = stream[Symbol.asyncIterator]();
    this.activeIterator = iterator;

    try {
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
        const type = event.type as string;
        log.debug({ eventType: type }, "codex event");

        switch (type) {
          case "thread.started": {
            yield {
              type: "session-start",
              sessionId: String(event.thread_id ?? sessionId ?? ""),
            };
            break;
          }

          case "agent_message": {
            const text = event.content as string | undefined;
            if (text) {
              yield { type: "text-delta", text };
            }
            break;
          }

          case "item.started": {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
              turnCount++;
              yield {
                type: "tool-use",
                toolCallId: String(item.call_id ?? crypto.randomUUID()),
                toolName: String(item.name ?? "unknown"),
                input: parseInput(item.arguments),
              };
            }
            break;
          }

          case "item.completed": {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call_output" || item?.type === "function_call") {
              yield {
                type: "tool-result",
                toolCallId: String(item.call_id ?? crypto.randomUUID()),
                output: String(item.output ?? ""),
                isError: false,
              };
            }
            break;
          }

          case "turn.completed": {
            yield {
              type: "session-result",
              success: true,
              sessionId: String(event.thread_id ?? sessionId ?? ""),
              durationMs: Date.now() - startMs,
              numTurns: turnCount,
              costUsd: (event.usage_usd as number) ?? 0,
              errors: [],
            };
            break;
          }

          case "turn.failed": {
            yield {
              type: "session-result",
              success: false,
              sessionId: String(event.thread_id ?? sessionId ?? ""),
              durationMs: Date.now() - startMs,
              numTurns: turnCount,
              costUsd: 0,
              errors: [String(event.error ?? "Codex turn failed")],
            };
            break;
          }
        }
      }
      log.info("codex stream done");
    } catch (err) {
      log.error({ err }, "codex error");
      throw err;
    } finally {
      this.activeIterator = null;
    }
  }

  async listSkills(): Promise<SkillInfo[]> {
    return discoverCodexSkills(this.workspaceDir);
  }

  listModels(): AgentModel[] {
    return [
      {
        id: "codex-mini",
        name: "Codex Mini",
        description: "Fast and efficient",
        contextWindow: 200_000,
      },
      { id: "o4-mini", name: "o4-mini", contextWindow: 200_000 },
    ];
  }
}

interface CodexThread {
  runStreamed(
    prompt: string,
    options?: {
      cwd?: string;
      maxTurns?: number;
      sandbox?: string;
    },
  ): AsyncIterable<Record<string, unknown>>;
}

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");

/**
 * Where freshly-shipped skills should be written. The OpenAI-Codex SDK
 * shares Codex CLI's skill home (`~/.codex/skills/`); `CODEX_HOME` is read
 * at call time so test overrides take effect.
 *
 * See https://developers.openai.com/codex/skills.
 */
export function getOpenAICodexInstallSkillsDir(home: string = homedir()): string {
  const codexHome = process.env.CODEX_HOME ?? join(home, ".codex");
  return join(codexHome, "skills");
}

function discoverCodexSkills(workspaceDir: string): SkillInfo[] {
  const globalSkillsDir = join(CODEX_HOME, "skills");
  const systemSkillsDir = join(CODEX_HOME, "skills", ".system");
  const projectSkillsDir = join(workspaceDir, ".codex", "skills");

  const systemSkills = readSkillsFromDir(systemSkillsDir);
  const globalSkills = readSkillsFromDir(globalSkillsDir);
  const projectSkills = readSkillsFromDir(projectSkillsDir);

  const skillMap = new Map<string, SkillInfo>();
  for (const skill of systemSkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of globalSkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of projectSkills) {
    skillMap.set(skill.name, skill);
  }

  return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function parseInput(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return { raw: args };
    }
  }
  if (typeof args === "object" && args !== null) {
    return args as Record<string, unknown>;
  }
  return {};
}
