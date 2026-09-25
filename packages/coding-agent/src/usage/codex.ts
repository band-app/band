import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "@band-app/logger";
import { computeCost } from "../pricing.ts";
import type { SessionUsageSnapshot, SessionUsageTurn } from "../types.ts";
import type { UsageReader, UsageSessionItem } from "./types.ts";

const log = createLogger("coding-agent:usage:codex");

/**
 * Codex rollout directory. Reads `CODEX_HOME` at call time (default
 * `~/.codex`) so test overrides take effect; `||` treats an empty value as
 * unset.
 */
function sessionsDir(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
}

/** Recursively find all .jsonl rollout files under `$CODEX_HOME/sessions/`. */
async function findSessionFiles(): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const s = await stat(full).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) {
        await walk(full);
      } else if (entry.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }
  await walk(sessionsDir());
  return results;
}

/** Read the `session_meta` record (the rollout's first line) from `file`. */
async function readSessionMeta(file: string): Promise<{ id: string; cwd: string } | undefined> {
  const rl = createInterface({
    input: createReadStream(file),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of rl) {
      const obj = JSON.parse(line) as { type?: string; payload?: { id?: string; cwd?: string } };
      if (obj.type === "session_meta" && obj.payload?.id && obj.payload.cwd) {
        return { id: obj.payload.id, cwd: obj.payload.cwd };
      }
    }
    return undefined;
  } finally {
    rl.close();
  }
}

/**
 * List Codex sessions whose `session_meta.cwd` equals `dir`. Codex keeps
 * every rollout under one date-partitioned tree, so this walks all of them.
 */
async function listSessions(dir: string): Promise<UsageSessionItem[]> {
  const sessions: UsageSessionItem[] = [];
  for (const file of await findSessionFiles()) {
    try {
      const meta = await readSessionMeta(file);
      if (!meta || meta.cwd !== dir) continue;
      const fileStat = await stat(file);
      sessions.push({ sessionId: meta.id, lastModified: fileStat.mtimeMs });
    } catch (err) {
      log.debug({ err, file }, "failed to parse codex session file");
    }
  }
  return sessions.sort((a, b) => b.lastModified - a.lastModified);
}

async function findRolloutFile(sessionId: string): Promise<string | undefined> {
  const files = await findSessionFiles();
  // Optimistic path: rollout files end with the session id (e.g.
  // `rollout-2026-04-19T11-23-00-<sessionId>.jsonl`). Fall back to a
  // `session_meta` scan if naming drifts.
  const byName = files.find((f) => f.endsWith(`${sessionId}.jsonl`));
  if (byName) return byName;
  for (const f of files) {
    try {
      const rl = createInterface({
        input: createReadStream(f),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      let match = false;
      for await (const line of rl) {
        const obj = JSON.parse(line) as { type?: string; payload?: { id?: string } };
        match = obj.type === "session_meta" && obj.payload?.id === sessionId;
        // Only the first line is the meta.
        break;
      }
      rl.close();
      if (match) return f;
    } catch {
      // Skip unreadable files.
    }
  }
  return undefined;
}

/**
 * Read per-turn token usage for one Codex session, computing cost via the
 * local ratecard (`pricing.ts`) since the OpenAI Responses API doesn't
 * surface a cost field.
 *
 * Codex emits `event_msg` lines with `payload.type == "token_count"` in its
 * rollout JSONL. Each carries a `last_token_usage` (delta for that turn) and
 * a `total_token_usage` (cumulative). We use **`last_token_usage`** —
 * summing `total_token_usage` would massively double-count (the 91×
 * inflation bug ccusage hit: github.com/ryoppippi/ccusage/issues/950).
 *
 * Model attribution: the most recent `turn_context` event preceding a
 * `token_count` carries the model id (Codex supports switching models
 * mid-session).
 *
 * Subagent guard: if the session's `session_meta` has a `parent_thread_id`,
 * the rollout re-replays the parent's history. Those rollouts return an
 * empty turn list and the parent rollout carries the real cost.
 */
async function getSessionUsage(
  sessionId: string,
  _dir: string,
): Promise<SessionUsageSnapshot | null> {
  const targetFile = await findRolloutFile(sessionId);
  if (!targetFile) return null;

  const turns: SessionUsageTurn[] = [];
  let turnIndex = 0;
  let startedAt = Number.POSITIVE_INFINITY;
  let updatedAt = 0;
  let modelFallback = "";
  let currentModel: string | undefined;
  let isSubagent = false;

  const rl = createInterface({
    input: createReadStream(targetFile),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: {
      type?: string;
      timestamp?: string;
      payload?: Record<string, unknown>;
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const tsMs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
    if (Number.isFinite(tsMs)) {
      startedAt = Math.min(startedAt, tsMs);
      updatedAt = Math.max(updatedAt, tsMs);
    }

    if (obj.type === "session_meta") {
      const parent = obj.payload?.parent_thread_id;
      if (typeof parent === "string" && parent.length > 0) {
        isSubagent = true;
        break;
      }
      continue;
    }

    if (obj.type === "turn_context") {
      const model = (obj.payload as { model?: string })?.model;
      if (typeof model === "string" && model.length > 0) {
        currentModel = model;
        if (!modelFallback) modelFallback = model;
      }
      continue;
    }

    if (obj.type !== "event_msg") continue;
    const payload = obj.payload as
      | {
          type?: string;
          info?: {
            last_token_usage?: {
              input_tokens?: number;
              cached_input_tokens?: number;
              output_tokens?: number;
              reasoning_output_tokens?: number;
            };
          };
        }
      | undefined;
    if (payload?.type !== "token_count") continue;
    const last = payload.info?.last_token_usage;
    if (!last) continue;

    const inputTokens = Number(last.input_tokens ?? 0);
    const cacheReadTokens = Number(last.cached_input_tokens ?? 0);
    const outputTokens = Number(last.output_tokens ?? 0);
    const reasoningOutputTokens = Number(last.reasoning_output_tokens ?? 0);

    // Codex's `input_tokens` is the FULL prompt size (already inclusive of
    // cached content). The ratecard prices uncached input separately from
    // cache reads, so subtract the cached subset before pricing. Floor at 0
    // in case the counts ever invert.
    const uncachedInput = Math.max(0, inputTokens - cacheReadTokens);

    const cost = computeCost(currentModel, {
      inputTokens: uncachedInput,
      outputTokens,
      cacheReadTokens,
      reasoningOutputTokens,
    });

    turns.push({
      turnIndex: turnIndex++,
      capturedAt: Number.isFinite(tsMs) ? tsMs : Date.now(),
      model: currentModel,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      reasoningOutputTokens,
      costUsd: cost,
    });
  }

  return {
    sessionId,
    modelFallback,
    startedAt: Number.isFinite(startedAt) ? startedAt : updatedAt || Date.now(),
    updatedAt: updatedAt || Date.now(),
    // Subagent rollouts still return a valid (empty) snapshot so the scanner
    // advances its watermark and doesn't re-attempt them.
    turns: isSubagent ? [] : turns,
  };
}

export const codexUsageReader: UsageReader = { listSessions, getSessionUsage };
