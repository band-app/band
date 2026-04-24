import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "@band-app/logger";
import type { OpenCodeConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import { readSkillsFromDir } from "../skills.js";
import type {
  AgentModel,
  CodingAgent,
  RunSessionOptions,
  SessionListItem,
  SessionMessageItem,
  SkillInfo,
} from "../types.js";

const log = createLogger("coding-agent:opencode");

export class OpenCodeAdapter implements CodingAgent {
  readonly name = "OpenCode";
  readonly supportedFeatures = {
    costTracking: false,
    sessionListing: true,
  } as const;

  private readonly workspaceDir: string;
  private readonly model: string | undefined;
  private readonly executablePath: string;
  private activeChild: ChildProcess | null = null;
  private cachedModels: AgentModel[] | null = null;

  constructor(config: OpenCodeConfig) {
    this.workspaceDir = config.workspaceDir;
    this.model = config.options.model;
    this.executablePath = config.options.executablePath ?? "opencode";
  }

  abort(): void {
    if (this.activeChild) {
      log.info("aborting active opencode process");
      this.activeChild.kill();
      this.activeChild = null;
    }
  }

  async *runSession(
    prompt: string,
    sessionId?: string,
    options?: RunSessionOptions,
  ): AsyncGenerator<AgentEvent> {
    const requestedModel = options?.model ?? this.model;
    // Only pass models that OpenCode actually supports. Ignore models from
    // other providers (e.g. Claude) to let OpenCode use its own default.
    // Use the cached models list if available; fall back to the hardcoded default list.
    const knownModelIds = new Set((this.cachedModels ?? DEFAULT_MODELS).map((m) => m.id));
    const effectiveModel =
      requestedModel && knownModelIds.has(requestedModel) ? requestedModel : undefined;

    log.info(
      {
        prompt: prompt.slice(0, 100),
        model: effectiveModel,
        cwd: this.workspaceDir,
        sessionId,
      },
      "runSession starting",
    );

    const startMs = Date.now();
    let turnCount = 0;
    const generatedSessionId = sessionId ?? crypto.randomUUID();

    yield { type: "session-start", sessionId: generatedSessionId };

    let gotOutput = false;
    let lastExitCode = 0;
    let lastStderr = "";
    let spawnError: Error | null = null;
    let effectiveSessionId: string | undefined = sessionId;
    const maxAttempts = sessionId ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts && !gotOutput; attempt++) {
      const args = ["run", "--format", "json", "--dir", this.workspaceDir];
      if (effectiveModel) {
        args.push("--model", effectiveModel);
      }
      if (effectiveSessionId) {
        args.push("--session", effectiveSessionId);
      }
      args.push(prompt);

      const child = spawn(this.executablePath, args, {
        cwd: this.workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      this.activeChild = child;

      // Capture spawn errors (e.g. ENOENT when binary is not found).
      // Without this listener an unhandled 'error' event on the child
      // process would crash the server.
      child.on("error", (err) => {
        spawnError = err;
        log.error({ err, executable: this.executablePath }, "opencode spawn error");
      });

      const stderrChunks: string[] = [];
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

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

          const eventType = parsed.type as string;
          const part = parsed.part as Record<string, unknown> | undefined;
          log.debug({ eventType }, "opencode event");

          switch (eventType) {
            case "text": {
              const text = part?.text as string | undefined;
              if (text) {
                gotOutput = true;
                yield { type: "text-delta", text };
              }
              break;
            }

            case "tool_use": {
              gotOutput = true;
              turnCount++;
              const state = part?.state as Record<string, unknown> | undefined;
              yield {
                type: "tool-use",
                toolCallId: String(part?.callID ?? crypto.randomUUID()),
                toolName: String(part?.tool ?? "unknown"),
                input: (state?.input as Record<string, unknown>) ?? {},
              };
              if (state?.status === "completed" || state?.status === "failed") {
                yield {
                  type: "tool-result",
                  toolCallId: String(part?.callID ?? ""),
                  toolName: String(part?.tool ?? "unknown"),
                  output: String(state?.output ?? ""),
                  isError: state?.status === "failed",
                };
              }
              break;
            }

            case "error": {
              gotOutput = true;
              const errMsg = String(
                parsed.message ?? parsed.error ?? part?.text ?? part?.message ?? "",
              );
              log.error({ event: parsed }, "opencode error event");
              yield {
                type: "error",
                message: errMsg || `OpenCode error (raw: ${JSON.stringify(parsed)})`,
              };
              break;
            }

            // step_start, step_finish — no Band equivalent, skip
          }
        }

        lastExitCode = await new Promise<number>((resolve) => {
          child.on("close", (code) => resolve(code ?? 0));
        });
        lastStderr = stderrChunks.join("");

        if (!gotOutput && effectiveSessionId && attempt < maxAttempts) {
          log.warn(
            { sessionId: effectiveSessionId, exitCode: lastExitCode, stderr: lastStderr },
            "opencode produced no output with session ID, retrying without session",
          );
          effectiveSessionId = undefined;
        }
      } catch (err) {
        log.error({ err }, "opencode error");
        child.kill();
        throw err;
      } finally {
        this.activeChild = null;
      }
    }

    if (spawnError) {
      const errMsg =
        (spawnError as NodeJS.ErrnoException).code === "ENOENT"
          ? `OpenCode executable not found: "${this.executablePath}". Is it installed and on your PATH?`
          : `OpenCode failed to start: ${(spawnError as Error).message}`;
      yield { type: "error", message: errMsg };
    } else if (!gotOutput && lastStderr) {
      yield {
        type: "error",
        message: `OpenCode produced no output: ${lastStderr.trim()}`,
      };
    }

    if (lastExitCode !== 0) {
      log.warn({ exitCode: lastExitCode }, "opencode process exited with non-zero code");
    }

    // Resolve the real OpenCode session ID (OpenCode creates its own IDs internally).
    // The session-start event used a placeholder UUID; now we look up the actual ID
    // so that session listing and resumption work correctly.
    let resolvedSessionId = generatedSessionId;
    if (!sessionId) {
      // Only resolve for NEW sessions (not resumptions where we already have the ID)
      try {
        // `opencode session list` already filters by CWD, so passing
        // workspaceDir as cwd gives us only sessions for this project.
        const sessions = await fetchOpenCodeSessions(this.executablePath, this.workspaceDir);
        const sorted = sessions.sort((a, b) => b.updated - a.updated);
        log.info(
          { placeholder: generatedSessionId, sessionCount: sessions.length },
          "resolving OpenCode session ID",
        );
        if (sorted.length > 0 && sorted[0].id) {
          resolvedSessionId = sorted[0].id;
          log.info(
            { placeholder: generatedSessionId, resolved: resolvedSessionId },
            "resolved real OpenCode session ID",
          );
          yield {
            type: "session-id-resolved",
            previousSessionId: generatedSessionId,
            resolvedSessionId,
          };
        } else {
          log.warn(
            { placeholder: generatedSessionId, workspaceDir: this.workspaceDir },
            "could NOT resolve real OpenCode session ID — no matching sessions found",
          );
        }
      } catch (err) {
        log.warn({ err }, "failed to resolve real OpenCode session ID");
      }
    }

    const success = lastExitCode === 0 && gotOutput && !spawnError;
    const errors: string[] = [];
    if (spawnError) {
      errors.push((spawnError as Error).message);
    }
    if (lastExitCode !== 0) {
      errors.push(`OpenCode exited with code ${lastExitCode}`);
    }
    if (!gotOutput && !spawnError) {
      errors.push("OpenCode produced no output");
    }

    yield {
      type: "session-result",
      success,
      sessionId: resolvedSessionId,
      durationMs: Date.now() - startMs,
      numTurns: turnCount,
      costUsd: 0,
      errors,
    };

    log.info("opencode stream done");
  }

  async listSkills(): Promise<SkillInfo[]> {
    return discoverOpenCodeSkills(this.workspaceDir);
  }

  async listModels(): Promise<AgentModel[]> {
    if (this.cachedModels) {
      return this.cachedModels;
    }

    try {
      const models = await fetchOpenCodeModels(this.executablePath);
      if (models.length > 0) {
        this.cachedModels = models;
        return models;
      }
    } catch (err) {
      log.warn({ err }, "failed to fetch models from opencode CLI, using defaults");
    }

    return DEFAULT_MODELS;
  }

  async listSessions(dir: string): Promise<SessionListItem[]> {
    // `opencode session list` already filters by CWD, so we just
    // pass `dir` as the working directory — no extra filtering needed.
    const sessions = await fetchOpenCodeSessions(this.executablePath, dir);
    log.info({ dir, count: sessions.length }, "listSessions");
    return sessions
      .map((s) => ({
        sessionId: s.id,
        summary: s.title || "Untitled session",
        lastModified: s.updated,
        firstPrompt: s.title,
      }))
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  async getSessionMessages(
    sessionId: string,
    _dir: string,
    options?: { limit?: number; offset?: number },
  ): Promise<SessionMessageItem[]> {
    log.info({ sessionId, ...options }, "getSessionMessages");
    return fetchOpenCodeSessionMessages(this.executablePath, sessionId, options);
  }
}

const DEFAULT_MODELS: AgentModel[] = [
  { id: "opencode/big-pickle", name: "Big Pickle" },
  { id: "opencode/gpt-5-nano", name: "GPT-5 Nano" },
];

function fetchOpenCodeModels(executablePath: string): Promise<AgentModel[]> {
  return new Promise((resolve, reject) => {
    execFile(executablePath, ["models", "--verbose"], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }

      const models: AgentModel[] = [];
      const lines = stdout.split("\n");
      let i = 0;

      while (i < lines.length) {
        const line = lines[i]!.trim();
        // Model IDs appear as "provider/model" lines before their JSON block
        if (line && !line.startsWith("{") && !line.startsWith("}") && line.includes("/")) {
          const modelId = line;
          // Try to find the JSON block that follows
          const jsonStart = i + 1;
          if (jsonStart < lines.length && lines[jsonStart]!.trim().startsWith("{")) {
            let depth = 0;
            let jsonEnd = jsonStart;
            for (let j = jsonStart; j < lines.length; j++) {
              const l = lines[j]!.trim();
              for (const ch of l) {
                if (ch === "{") depth++;
                if (ch === "}") depth--;
              }
              if (depth === 0) {
                jsonEnd = j;
                break;
              }
            }
            const jsonStr = lines.slice(jsonStart, jsonEnd + 1).join("\n");
            try {
              const meta = JSON.parse(jsonStr) as { name?: string; providerID?: string };
              models.push({
                id: modelId,
                name: meta.name ?? modelId,
                description: meta.providerID,
              });
            } catch {
              models.push({ id: modelId, name: modelId });
            }
            i = jsonEnd + 1;
            continue;
          }
          models.push({ id: modelId, name: modelId });
        }
        i++;
      }

      resolve(models);
    });
  });
}

// ─── Session history ─────────────────────────────────────────────────────────

interface OpenCodeSessionListEntry {
  id: string;
  title: string;
  updated: number;
  created: number;
  projectId: string;
  directory: string;
}

function fetchOpenCodeSessions(
  executablePath: string,
  cwd?: string,
): Promise<OpenCodeSessionListEntry[]> {
  return new Promise((resolve, reject) => {
    execFile(
      executablePath,
      ["session", "list", "--format", "json"],
      { timeout: 10_000, cwd },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as OpenCodeSessionListEntry[]);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

interface OpenCodeExportedSession {
  info: {
    id: string;
    title: string;
    directory: string;
  };
  messages: OpenCodeExportedMessage[];
}

interface OpenCodeExportedMessage {
  info: {
    role: "user" | "assistant";
    id: string;
  };
  parts: OpenCodeExportedPart[];
}

type OpenCodeExportedPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      callID: string;
      tool: string;
      state: {
        status: string;
        input: Record<string, unknown>;
        output?: string;
        title?: string;
        metadata?: { exit?: number; output?: string };
      };
    }
  | { type: "step-start" }
  | { type: "step-finish" };

async function fetchOpenCodeSessionMessages(
  executablePath: string,
  sessionId: string,
  options?: { limit?: number; offset?: number },
): Promise<SessionMessageItem[]> {
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(
      executablePath,
      ["export", sessionId],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });

  // `opencode export` prefixes output with "Exporting session: ..." line
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return [];

  let session: OpenCodeExportedSession;
  try {
    session = JSON.parse(raw.slice(jsonStart)) as OpenCodeExportedSession;
  } catch {
    log.warn({ sessionId }, "failed to parse exported session");
    return [];
  }

  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? Number.POSITIVE_INFINITY;
  const messages: SessionMessageItem[] = [];
  let msgIndex = 0;

  for (const msg of session.messages) {
    const role = msg.info.role;
    if (role !== "user" && role !== "assistant") continue;

    const content: SessionMessageItem["content"] = [];

    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
          if (part.text) {
            // OpenCode wraps user text in quotes and adds a trailing newline
            const text = role === "user" ? part.text.trim().replace(/^"|"$/g, "") : part.text;
            content.push({ type: "text", text });
          }
          break;

        case "tool":
          content.push({
            type: "tool_use",
            toolCallId: part.callID,
            toolName: part.tool,
            input: part.state.input ?? {},
          });
          if (part.state.status === "completed" || part.state.status === "failed") {
            content.push({
              type: "tool_result",
              toolCallId: part.callID,
              output: part.state.output ?? part.state.metadata?.output ?? "",
              isError: part.state.status === "failed",
            });
          }
          break;

        // step-start, step-finish, reasoning — skip
      }
    }

    if (content.length === 0) continue;

    if (msgIndex >= offset && msgIndex < offset + limit) {
      messages.push({
        role,
        id: msg.info.id,
        content,
      });
    }
    msgIndex++;

    if (msgIndex >= offset + limit) break;
  }

  return messages;
}

/**
 * Discover skills using OpenCode's 6-directory resolution order.
 *
 * Priority (lowest to highest — later entries override earlier ones):
 *   6. ~/.agents/skills/
 *   5. ~/.claude/skills/
 *   4. ~/.config/opencode/skills/
 *   3. <project>/.agents/skills/
 *   2. <project>/.claude/skills/
 *   1. <project>/.opencode/skills/
 */
function discoverOpenCodeSkills(workspaceDir: string): SkillInfo[] {
  const home = homedir();
  const dirs = [
    // Global (lowest priority first)
    join(home, ".agents", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".config", "opencode", "skills"),
    // Project-level (overrides global)
    join(workspaceDir, ".agents", "skills"),
    join(workspaceDir, ".claude", "skills"),
    join(workspaceDir, ".opencode", "skills"),
  ];

  const skillMap = new Map<string, SkillInfo>();
  for (const dir of dirs) {
    for (const skill of readSkillsFromDir(dir)) {
      skillMap.set(skill.name, skill);
    }
  }

  return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
