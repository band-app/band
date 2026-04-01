import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "@band-app/logger";
import type { GeminiCliConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import { readSkillsFromDir } from "../skills.js";
import type { AgentModel, CodingAgent, RunSessionOptions, SkillInfo } from "../types.js";

const log = createLogger("coding-agent:gemini-cli");

export class GeminiCliAdapter implements CodingAgent {
  readonly name = "Gemini CLI";
  readonly supportedFeatures = {
    costTracking: false,
    sessionListing: false,
  } as const;

  private readonly workspaceDir: string;
  private readonly maxTurns: number;
  private readonly model: string | undefined;
  private readonly executablePath: string;
  private activeChild: ChildProcess | null = null;

  constructor(config: GeminiCliConfig) {
    this.workspaceDir = config.workspaceDir;
    this.maxTurns = config.maxTurns;
    this.model = config.options.model;
    this.executablePath = config.options.executablePath ?? "gemini";
  }

  abort(): void {
    if (this.activeChild) {
      log.info("aborting active gemini process");
      this.activeChild.kill();
      this.activeChild = null;
    }
  }

  async *runSession(
    prompt: string,
    _sessionId?: string,
    options?: RunSessionOptions,
  ): AsyncGenerator<AgentEvent> {
    const effectiveMaxTurns = options?.maxTurns ?? this.maxTurns;
    const effectiveModel = options?.model ?? this.model;

    log.info(
      {
        prompt: prompt.slice(0, 100),
        model: effectiveModel,
        cwd: this.workspaceDir,
        maxTurns: effectiveMaxTurns,
      },
      "runSession starting",
    );

    const args = ["--output-format", "stream-json"];
    if (effectiveModel) {
      args.push("--model", effectiveModel);
    }
    args.push("--", prompt);

    const child = spawn(this.executablePath, args, {
      cwd: this.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.activeChild = child;

    const startMs = Date.now();
    let turnCount = 0;
    const sessionId = crypto.randomUUID();

    yield { type: "session-start", sessionId };

    const rl = createInterface({ input: child.stdout });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          log.warn({ line }, "failed to parse NDJSON line");
          continue;
        }

        const type = parsed.type as string;
        log.debug({ eventType: type }, "gemini event");

        switch (type) {
          case "message": {
            const text = parsed.text as string | undefined;
            if (text) {
              yield { type: "text-delta", text };
            }
            break;
          }

          case "tool_use": {
            turnCount++;
            yield {
              type: "tool-use",
              toolCallId: String(parsed.id ?? crypto.randomUUID()),
              toolName: String(parsed.name ?? "unknown"),
              input: (parsed.input as Record<string, unknown>) ?? {},
            };
            break;
          }

          case "tool_result": {
            yield {
              type: "tool-result",
              toolCallId: String(parsed.tool_use_id ?? crypto.randomUUID()),
              output: String(parsed.output ?? ""),
              isError: (parsed.is_error as boolean) ?? false,
            };
            break;
          }

          case "result": {
            const success = parsed.status === "success";
            yield {
              type: "session-result",
              success,
              sessionId,
              durationMs: Date.now() - startMs,
              numTurns: turnCount,
              costUsd: 0,
              errors: success ? [] : [String(parsed.error ?? "Gemini CLI error")],
            };
            break;
          }

          case "error": {
            yield {
              type: "error",
              message: String(parsed.message ?? "Unknown Gemini CLI error"),
            };
            break;
          }
        }
      }

      const exitCode = await new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 0));
      });

      if (exitCode !== 0) {
        log.warn({ exitCode }, "gemini process exited with non-zero code");
      }

      log.info("gemini stream done");
    } catch (err) {
      log.error({ err }, "gemini error");
      child.kill();
      throw err;
    } finally {
      this.activeChild = null;
    }
  }

  async listSkills(): Promise<SkillInfo[]> {
    return discoverGeminiSkills(this.workspaceDir);
  }

  listModels(): AgentModel[] {
    return [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Most capable" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast and efficient" },
    ];
  }
}

function discoverGeminiSkills(workspaceDir: string): SkillInfo[] {
  const globalSkillsDir = join(homedir(), ".gemini", "skills");
  const projectSkillsDir = join(workspaceDir, ".gemini", "skills");

  const globalSkills = readSkillsFromDir(globalSkillsDir);
  const projectSkills = readSkillsFromDir(projectSkillsDir);

  const skillMap = new Map<string, SkillInfo>();
  for (const skill of globalSkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of projectSkills) {
    skillMap.set(skill.name, skill);
  }

  return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
