import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "@band-app/logger";
import { AGENT_DISPATCH_ENV } from "../adapter-env.js";
import type { GeminiCliConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import { readSkillsFromDir } from "../skills.js";
import type {
  AgentModel,
  CliInvocation,
  CodingAgent,
  RunSessionOptions,
  SkillInfo,
} from "../types.js";

const log = createLogger("coding-agent:gemini-cli");

export class GeminiCliAdapter implements CodingAgent {
  readonly name = "Gemini CLI";
  readonly supportedFeatures = {
    costTracking: false,
    sessionListing: false,
  } as const;

  private readonly workspaceDir: string;
  private readonly model: string | undefined;
  private readonly executablePath: string;
  private activeChild: ChildProcess | null = null;

  constructor(config: GeminiCliConfig) {
    this.workspaceDir = config.workspaceDir;
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
    const requestedModel = options?.model ?? this.model;
    // Only pass models that Gemini CLI supports. Ignore models from other
    // providers (e.g. Claude/GPT) to let Gemini use its own default.
    const knownGeminiModels = new Set(this.listModels().map((m) => m.id));
    const effectiveModel =
      requestedModel && knownGeminiModels.has(requestedModel) ? requestedModel : undefined;

    log.info(
      {
        prompt: prompt.slice(0, 100),
        model: effectiveModel,
        cwd: this.workspaceDir,
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
      // BAND_DISPATCH=chat so a nested `band` CLI call from this agent
      // dispatches back into a chat pane (see adapter-env.ts).
      env: { ...process.env, ...AGENT_DISPATCH_ENV },
    });
    this.activeChild = child;

    // Capture spawn errors (e.g. ENOENT when binary is not found).
    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
      log.error({ err, executable: this.executablePath }, "gemini spawn error");
    });

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

      if (spawnError) {
        const errMsg =
          (spawnError as NodeJS.ErrnoException).code === "ENOENT"
            ? `Gemini CLI executable not found: "${this.executablePath}". Is it installed and on your PATH?`
            : `Gemini CLI failed to start: ${(spawnError as Error).message}`;
        yield { type: "error", message: errMsg };
        yield {
          type: "session-result",
          success: false,
          sessionId,
          durationMs: Date.now() - startMs,
          numTurns: 0,
          costUsd: 0,
          errors: [errMsg],
        };
      } else if (exitCode !== 0) {
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
    return GEMINI_MODELS;
  }

  /**
   * Gemini CLI doesn't expose a `models` listing command, so the live
   * list IS the hardcoded `GEMINI_MODELS` array. Returning it here makes
   * `ModelRefreshService.refresh()` Just Work — the persisted cache lines
   * up with whatever the adapter would otherwise serve from `listModels()`.
   */
  async refreshModels(): Promise<AgentModel[]> {
    return GEMINI_MODELS;
  }

  /**
   * Resolved CLI invocation for `workspaces.create --via terminal`
   * (issue #551). Opens an interactive Gemini CLI REPL with `prompt`
   * pre-loaded as the first positional argument (cmux-style:
   * `gemini -- "<prompt>"`). The end-of-options `--` mirrors
   * `runSession` above and prevents a prompt that starts with `-` from
   * being parsed as a flag by the Gemini binary.
   */
  cliInvocation(prompt: string): CliInvocation {
    return {
      command: this.executablePath,
      args: ["--", prompt],
    };
  }

  /**
   * Headless one-shot invocation for automated terminal dispatch (cronjobs,
   * issue #581). `gemini --prompt=<prompt>` runs non-interactively and exits
   * on completion — unlike `cliInvocation`'s `gemini -- "<prompt>"`, which
   * opens the interactive REPL and stays parked. The `--prompt=<value>`
   * joined form (rather than `--prompt <value>`) binds the prompt as the
   * flag's argument even when it starts with `-`, mirroring the leading-dash
   * safety the interactive `--` guard provides.
   *
   * `--output-format` is deliberately omitted (unlike `runSession`, which asks
   * for NDJSON): a cron terminal shows plain human-readable output in the pane,
   * not a machine-parsed stream.
   */
  cliHeadlessInvocation(prompt: string): CliInvocation {
    return {
      command: this.executablePath,
      args: [`--prompt=${prompt}`],
    };
  }

  /**
   * The chat tab's "Continue in terminal" action has no Gemini equivalent:
   * the Gemini CLI has no session model, so there's no session ID to resume
   * by. Returning the `unsupported` sentinel keeps the menu item disabled.
   */
  resumeCliInvocation(_sessionId: string): CliInvocation {
    return {
      unsupported: true,
      reason: "Gemini CLI has no session-resume invocation.",
    };
  }
}

/** Default executable name for the Gemini CLI. */
export const GEMINI_CLI_DEFAULT_BINARY = "gemini";

const GEMINI_MODELS: AgentModel[] = [
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    description: "Most capable",
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description: "Fast and efficient",
    contextWindow: 1_000_000,
  },
];

/**
 * Where freshly-shipped skills should be written. Gemini CLI's user-scope
 * skills live at `~/.gemini/skills/` (not affected by workspace trust),
 * with `~/.agents/skills/` documented as a tool-agnostic alias. We pick
 * the canonical Gemini path so other tools (like band) sync into the
 * place Gemini actually scans first.
 *
 * See https://geminicli.com/docs/cli/skills/.
 */
export function getGeminiCliInstallSkillsDir(home: string = homedir()): string {
  return join(home, ".gemini", "skills");
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
