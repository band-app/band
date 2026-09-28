import { execFile } from "node:child_process";
import { createLogger } from "@band-app/logger";
import { OPENCODE_DEFAULT_BINARY } from "../install-skills.ts";
import type { SessionUsageSnapshot, SessionUsageTurn } from "../types.ts";
import type { UsageReader, UsageSessionItem } from "./types.ts";

const log = createLogger("coding-agent:usage:opencode");

interface OpenCodeSessionListEntry {
  id: string;
  title: string;
  updated: number;
  created: number;
  projectId: string;
  directory: string;
}

interface OpenCodeExportedSession {
  info: {
    id: string;
    /** Created / updated timestamps (epoch ms). */
    time?: { created?: number; updated?: number };
  };
  messages: Array<{
    info: {
      role: "user" | "assistant";
      /** Model id when assistant; absent for user messages. */
      modelID?: string;
      /** Epoch ms when the message landed. */
      time?: { created?: number };
    };
    parts: Array<
      | { type: "text" | "reasoning" | "tool" | "step-start" }
      | {
          type: "step-finish";
          /** USD cost reported by OpenCode for this step. */
          cost?: number;
          /** Per-step token splits. `cache.write` is reported but dropped. */
          tokens?: {
            input?: number;
            output?: number;
            reasoning?: number;
            cache?: { read?: number; write?: number };
          };
          /** Epoch ms when the step completed. */
          time?: number;
        }
    >;
  }>;
}

/**
 * OpenCode usage reader. OpenCode keeps sessions in its own store, so both
 * methods shell out to the `opencode` binary (`command` from the agent
 * definition, default `opencode`).
 */
export function createOpenCodeUsageReader(command: string = OPENCODE_DEFAULT_BINARY): UsageReader {
  /**
   * `opencode session list` already filters by CWD, so `dir` is passed as
   * the working directory — no extra filtering needed.
   */
  async function listSessions(dir: string): Promise<UsageSessionItem[]> {
    const sessions = await new Promise<OpenCodeSessionListEntry[]>((resolve, reject) => {
      execFile(
        command,
        ["session", "list", "--format", "json"],
        { timeout: 10_000, cwd: dir },
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
    log.debug({ dir, count: sessions.length }, "listSessions");
    return sessions
      .map((s) => ({ sessionId: s.id, lastModified: s.updated }))
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  /**
   * Read per-turn token + USD cost for one session by shelling out to
   * `opencode export <sessionId>` and walking the assistant messages'
   * `step-finish` parts. Each `step-finish` is one LLM round-trip with
   * `cost` (USD) and `tokens.{input,output,reasoning,cache.read}` inline.
   *
   * `cache.write` tokens are intentionally dropped — `cacheCreationTokens`
   * is reserved for Claude, and OpenCode's cache-write count is typically
   * zero.
   *
   * Returns `null` when the session isn't found / export fails.
   */
  async function getSessionUsage(
    sessionId: string,
    _dir: string,
  ): Promise<SessionUsageSnapshot | null> {
    let raw: string;
    try {
      raw = await new Promise<string>((resolve, reject) => {
        execFile(
          command,
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
    } catch (err) {
      // ENOENT-style errors (session missing, opencode binary missing)
      // collapse to "no data". Debug level so a scanner pass over a fresh
      // workspace isn't noisy.
      log.debug({ err, sessionId }, "opencode export failed; treating as no data");
      return null;
    }

    const jsonStart = raw.indexOf("{");
    if (jsonStart === -1) return null;
    let session: OpenCodeExportedSession;
    try {
      session = JSON.parse(raw.slice(jsonStart)) as OpenCodeExportedSession;
    } catch {
      log.warn({ sessionId }, "failed to parse opencode export for usage");
      return null;
    }

    const turns: SessionUsageTurn[] = [];
    let turnIndex = 0;
    let startedAt = Number.POSITIVE_INFINITY;
    let updatedAt = 0;
    let modelFallback = "";

    if (session.info.time?.created) {
      startedAt = Math.min(startedAt, session.info.time.created);
    }
    if (session.info.time?.updated) {
      updatedAt = Math.max(updatedAt, session.info.time.updated);
    }

    for (const msg of session.messages) {
      if (msg.info.role !== "assistant") continue;
      const msgModel = msg.info.modelID;
      if (msgModel && !modelFallback) modelFallback = msgModel;
      const msgCreated = msg.info.time?.created ?? 0;
      if (msgCreated > 0) {
        startedAt = Math.min(startedAt, msgCreated);
        updatedAt = Math.max(updatedAt, msgCreated);
      }

      for (const part of msg.parts) {
        if (part.type !== "step-finish") continue;
        const tokens = part.tokens ?? {};
        const inputTokens = Number(tokens.input ?? 0);
        const outputTokens = Number(tokens.output ?? 0);
        const reasoningOutputTokens = Number(tokens.reasoning ?? 0);
        const cacheReadTokens = Number(tokens.cache?.read ?? 0);
        const costUsd = Number(part.cost ?? 0);

        // Skip totally-empty step-finish entries — real OpenCode steps
        // always have at least output tokens.
        if (
          inputTokens === 0 &&
          outputTokens === 0 &&
          reasoningOutputTokens === 0 &&
          cacheReadTokens === 0 &&
          costUsd === 0
        ) {
          continue;
        }

        const capturedAt = part.time ?? msgCreated ?? Date.now();
        if (capturedAt > 0) {
          startedAt = Math.min(startedAt, capturedAt);
          updatedAt = Math.max(updatedAt, capturedAt);
        }

        turns.push({
          turnIndex: turnIndex++,
          capturedAt,
          model: msgModel,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          reasoningOutputTokens,
          costUsd,
        });
      }
    }

    return {
      sessionId,
      modelFallback,
      startedAt: Number.isFinite(startedAt) ? startedAt : updatedAt || Date.now(),
      updatedAt: updatedAt || Date.now(),
      turns,
    };
  }

  return { listSessions, getSessionUsage };
}
