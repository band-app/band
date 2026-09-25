import { createReadStream } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { computeCost } from "../pricing.ts";
import type { SessionUsageSnapshot, SessionUsageTurn } from "../types.ts";
import type { UsageReader, UsageSessionItem } from "./types.ts";

/**
 * Claude Code usage reader for the Reports scanner (issue #425).
 *
 * Reads Claude Code's per-project session transcripts directly from
 * `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl` (default
 * `~/.claude/projects/...`). No SDK import: the directory layout and the
 * cwd encoding below mirror `@anthropic-ai/claude-agent-sdk`'s own
 * `listSessions` / `getSessionMessages` implementation.
 */

/** Longest encoded project-dir name before the SDK appends a hash suffix. */
const MAX_ENCODED_DIR_LENGTH = 200;

/** Bytes read from the head of a session file to find its `cwd`. */
const SESSION_HEAD_BYTES = 64 * 1024;

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function claudeConfigDir(): string {
  // `||` (not `??`) so an empty `CLAUDE_CONFIG_DIR=` falls back to the default.
  return (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")).normalize("NFC");
}

/** 32-bit Java-style string hash, identical to the SDK's `mB`. */
function hashString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Encode an absolute cwd into Claude's project directory name: every
 * non-alphanumeric character becomes `-`. Names longer than 200 characters
 * are truncated and suffixed with `-<base36 hash of the original path>`,
 * matching the SDK's `x1` encoder.
 */
export function encodeClaudeProjectDir(absDir: string): string {
  const encoded = absDir.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= MAX_ENCODED_DIR_LENGTH) return encoded;
  return `${encoded.slice(0, MAX_ENCODED_DIR_LENGTH)}-${Math.abs(hashString(absDir)).toString(36)}`;
}

async function canonicalDir(dir: string): Promise<string> {
  try {
    return (await realpath(dir)).normalize("NFC");
  } catch {
    return dir.normalize("NFC");
  }
}

/**
 * Project directories that may hold sessions for `canonical`. For long paths
 * the SDK also accepts any sibling that shares the truncated prefix, because
 * the Claude Code CLI (built on Bun) may hash the path differently.
 */
async function projectDirsFor(canonical: string): Promise<string[]> {
  const projectsRoot = join(claudeConfigDir(), "projects");
  const exact = join(projectsRoot, encodeClaudeProjectDir(canonical));
  const dirs = [exact];
  const encoded = canonical.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= MAX_ENCODED_DIR_LENGTH) return dirs;
  const prefix = `${encoded.slice(0, MAX_ENCODED_DIR_LENGTH)}-`;
  try {
    for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const full = join(projectsRoot, entry.name);
      if (full !== exact) dirs.push(full);
    }
  } catch {
    // No projects root yet — only the exact candidate applies.
  }
  return dirs;
}

/**
 * Read the head of a session file and return the `cwd` it was recorded in,
 * or `null` when the file is empty or its first record is a sidechain
 * (subagent) transcript — both of which the SDK's `listSessions` drops.
 */
async function readSessionCwd(file: string): Promise<string | undefined | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const buf = Buffer.alloc(SESSION_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SESSION_HEAD_BYTES, 0);
    if (bytesRead === 0) return null;
    const lines = buf.toString("utf8", 0, bytesRead).split("\n");
    const firstLine = lines[0] ?? "";
    if (firstLine.includes('"isSidechain":true') || firstLine.includes('"isSidechain": true')) {
      return null;
    }
    for (const line of lines) {
      if (!line.includes('"cwd"')) continue;
      try {
        const record = JSON.parse(line) as { cwd?: unknown };
        if (typeof record.cwd === "string") return record.cwd;
      } catch {
        // Truncated tail line or malformed record — keep scanning.
      }
    }
    return undefined;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** How many session files `listSessions` reads at once. A project dir can
 *  hold thousands; reading them all at once would hold one fd and one head
 *  buffer per file. */
const READ_CONCURRENCY = 16;

async function forEachLimited<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * List the sessions Claude Code recorded for `dir`.
 *
 * Mirrors the retired adapter's `listSessions`, which called the SDK's
 * `listSessions({ dir })` and kept only sessions whose recorded `cwd`
 * equals `dir`. Sessions from sibling git worktrees live in their own
 * project directories, so a scan of `dir`'s directory plus the `cwd`
 * check returns the same set.
 */
async function listSessions(dir: string): Promise<UsageSessionItem[]> {
  const canonical = await canonicalDir(dir);
  const bySession = new Map<string, UsageSessionItem>();

  for (const projectDir of await projectDirsFor(canonical)) {
    let names: string[];
    try {
      names = await readdir(projectDir);
    } catch {
      continue;
    }
    await forEachLimited(names, READ_CONCURRENCY, async (name) => {
      if (!name.endsWith(".jsonl")) return;
      const sessionId = name.slice(0, -".jsonl".length);
      if (!SESSION_ID_RE.test(sessionId)) return;
      const file = join(projectDir, name);
      const cwd = await readSessionCwd(file);
      if (cwd === null) return;
      // Files without a recorded cwd are attributed to the project dir
      // they live in, as the SDK does.
      if (cwd !== undefined && cwd !== dir && cwd !== canonical) return;
      let lastModified: number;
      try {
        lastModified = (await stat(file)).mtimeMs;
      } catch {
        return;
      }
      const existing = bySession.get(sessionId);
      if (!existing || lastModified > existing.lastModified) {
        bySession.set(sessionId, { sessionId, lastModified });
      }
    });
  }

  return [...bySession.values()].sort((a, b) => b.lastModified - a.lastModified);
}

async function findSessionFile(sessionId: string, dir: string): Promise<string | undefined> {
  for (const projectDir of await projectDirsFor(await canonicalDir(dir))) {
    const file = join(projectDir, `${sessionId}.jsonl`);
    try {
      if ((await stat(file)).size > 0) return file;
    } catch {
      // Not in this project dir.
    }
  }
  return undefined;
}

interface ClaudeTranscriptRecord {
  type?: string;
  timestamp?: string | number;
  isSidechain?: boolean;
  isMeta?: boolean;
  teamName?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/**
 * Read per-turn token + USD cost for a single session.
 *
 * Claude Code's session JSONL does NOT persist `total_cost_usd` (the SDK
 * computes it at query time). It does contain `assistant` records carrying
 * `message.usage.*` and `message.model` for each API round-trip. One API
 * message = one turn, priced from the `pricing.ts` ratecard.
 *
 * Claude Code writes one JSONL record per content block of an assistant
 * message, each repeating the message's `id` and `usage`. Turns are keyed
 * by `message.id` so those repeats count once; the last record wins because
 * it carries the final token counts.
 *
 * Sidechain (subagent), meta and team records are skipped, matching the
 * SDK's `getSessionMessages` filter.
 *
 * Returns `null` when the session file isn't found or holds no
 * user/assistant records — the scanner skips it silently.
 */
async function getSessionUsage(
  sessionId: string,
  dir: string,
): Promise<SessionUsageSnapshot | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const file = await findSessionFile(sessionId, dir);
  if (!file) return null;

  const turns: SessionUsageTurn[] = [];
  const turnByMessageId = new Map<string, SessionUsageTurn>();
  let conversationRecords = 0;
  let startedAt = Number.POSITIVE_INFINITY;
  let updatedAt = 0;
  let modelFallback = "";

  const rl = createInterface({
    input: createReadStream(file),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let record: ClaudeTranscriptRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (record.isSidechain || record.isMeta || record.teamName) continue;
    conversationRecords++;

    const tsRaw = record.timestamp;
    const capturedAt =
      typeof tsRaw === "number"
        ? tsRaw
        : typeof tsRaw === "string"
          ? Date.parse(tsRaw)
          : Number.NaN;
    if (Number.isFinite(capturedAt)) {
      startedAt = Math.min(startedAt, capturedAt);
      updatedAt = Math.max(updatedAt, capturedAt);
    }

    if (record.type !== "assistant") continue;
    const usage = record.message?.usage;
    if (!usage) continue;
    const model = record.message?.model;
    if (model && !modelFallback) modelFallback = model;

    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

    const turn: SessionUsageTurn = {
      // Assigned after the walk, once repeats and zero rows are dropped.
      turnIndex: 0,
      capturedAt: Number.isFinite(capturedAt) ? capturedAt : Date.now(),
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUsd: computeCost(model, {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      }),
    };

    const messageId = record.message?.id;
    const previous = messageId ? turnByMessageId.get(messageId) : undefined;
    if (previous) {
      Object.assign(previous, turn);
      continue;
    }
    turns.push(turn);
    if (messageId) turnByMessageId.set(messageId, turn);
  }

  if (conversationRecords === 0) return null;

  // Skip zero rows (structural assistant records rather than API round-trips)
  // and number the survivors in file order.
  const billable = turns.filter(
    (t) =>
      t.inputTokens !== 0 ||
      t.outputTokens !== 0 ||
      (t.cacheReadTokens ?? 0) !== 0 ||
      (t.cacheCreationTokens ?? 0) !== 0,
  );
  billable.forEach((t, i) => {
    t.turnIndex = i;
  });

  return {
    sessionId,
    modelFallback,
    startedAt: Number.isFinite(startedAt) ? startedAt : updatedAt || Date.now(),
    updatedAt: updatedAt || Date.now(),
    turns: billable,
  };
}

export const claudeCodeUsageReader: UsageReader = { listSessions, getSessionUsage };
