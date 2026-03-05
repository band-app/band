import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createLogger } from "@band/logger";
import type { GeminiCliConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import type { CodingAgent } from "../types.js";

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

  constructor(config: GeminiCliConfig) {
    this.workspaceDir = config.workspaceDir;
    this.maxTurns = config.maxTurns;
    this.model = config.options.model;
    this.executablePath = config.options.executablePath ?? "gemini";
  }

  async *runSession(prompt: string, _sessionId?: string): AsyncGenerator<AgentEvent> {
    log.info(
      {
        prompt: prompt.slice(0, 100),
        model: this.model,
        cwd: this.workspaceDir,
        maxTurns: this.maxTurns,
      },
      "runSession starting",
    );

    const args = ["--output-format", "stream-json"];
    if (this.model) {
      args.push("--model", this.model);
    }
    args.push("--", prompt);

    const child = spawn(this.executablePath, args, {
      cwd: this.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
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

      if (exitCode !== 0) {
        log.warn({ exitCode }, "gemini process exited with non-zero code");
      }

      log.info("gemini stream done");
    } catch (err) {
      log.error({ err }, "gemini error");
      child.kill();
      throw err;
    }
  }
}
