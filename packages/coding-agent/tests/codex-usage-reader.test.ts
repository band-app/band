/**
 * Tests for the Codex usage reader (`src/usage/codex.ts`), which the Reports
 * scanner uses to list a workspace's sessions and read their token usage from
 * the rollout JSONL files under `$CODEX_HOME/sessions/`.
 *
 * Real temp directories only: each test writes rollout files in the
 * date-partitioned layout Codex produces and points `CODEX_HOME` at the
 * sandbox.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { codexUsageReader } from "../src/usage/codex.ts";

let root: string;
let workspace: string;
let dayDir: string;
let originalCodexHome: string | undefined;

function sessionId(n: number): string {
  return `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function metaRecord(id: string, cwd: string, extra: object = {}): object {
  return {
    timestamp: "2026-04-19T11:23:00.000Z",
    type: "session_meta",
    payload: { id, cwd, ...extra },
  };
}

function turnContext(model: string): object {
  return { timestamp: "2026-04-19T11:23:01.000Z", type: "turn_context", payload: { model } };
}

function tokenCount(timestamp: string, last: object): object {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: last } },
  };
}

/** Write a rollout file and return its path. `fileName` defaults to Codex's naming. */
function writeRollout(id: string, records: object[], fileName?: string): string {
  const file = join(dayDir, fileName ?? `rollout-2026-04-19T11-23-00-${id}.jsonl`);
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return file;
}

/** Open fds of this process. `/dev/fd` exists on macOS and Linux, where CI runs. */
function openFdCount(): number {
  return readdirSync("/dev/fd").length;
}

/**
 * Wait for the open-fd count to fall back to `baseline`. Destroying a stream
 * closes its fd asynchronously, so a correct reader settles within a few
 * ticks; a leaking one never does.
 */
async function settledFdCount(baseline: number): Promise<number> {
  let count = openFdCount();
  for (let i = 0; i < 50 && count > baseline; i++) {
    await delay(20);
    count = openFdCount();
  }
  return count;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "band-codex-usage-")));
  workspace = join(root, "workspaces", "my-repo");
  mkdirSync(workspace, { recursive: true });
  dayDir = join(root, "codex", "sessions", "2026", "04", "19");
  mkdirSync(dayDir, { recursive: true });
  originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
});

afterEach(() => {
  if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome;
  else delete process.env.CODEX_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("codexUsageReader.listSessions", () => {
  it("returns only sessions whose session_meta cwd matches the directory", async () => {
    writeRollout(sessionId(1), [metaRecord(sessionId(1), workspace)]);
    writeRollout(sessionId(2), [metaRecord(sessionId(2), join(root, "elsewhere"))]);

    const sessions = await codexUsageReader.listSessions(workspace);

    assert.deepEqual(
      sessions.map((s) => s.sessionId),
      [sessionId(1)],
    );
  });

  it("re-reads a rollout's session_meta when the file's mtime changes", async () => {
    const other = join(root, "elsewhere");
    const file = writeRollout(sessionId(1), [metaRecord(sessionId(1), other)]);
    utimesSync(file, 1_000, 1_000);
    assert.deepEqual(await codexUsageReader.listSessions(workspace), []);

    writeRollout(sessionId(1), [metaRecord(sessionId(1), workspace)]);
    utimesSync(file, 2_000, 2_000);

    assert.deepEqual(await codexUsageReader.listSessions(workspace), [
      { sessionId: sessionId(1), lastModified: 2_000_000 },
    ]);
  });

  it("lists a rollout once a half-written session_meta is completed", async () => {
    const file = join(dayDir, `rollout-2026-04-19T11-23-00-${sessionId(1)}.jsonl`);
    writeFileSync(file, '{"type":"session_meta","payload":{"id":');
    utimesSync(file, 1_000, 1_000);
    assert.deepEqual(await codexUsageReader.listSessions(workspace), []);

    writeRollout(sessionId(1), [metaRecord(sessionId(1), workspace)]);
    utimesSync(file, 2_000, 2_000);

    assert.deepEqual(await codexUsageReader.listSessions(workspace), [
      { sessionId: sessionId(1), lastModified: 2_000_000 },
    ]);
  });
});

describe("codexUsageReader.getSessionUsage", () => {
  it("sums per-turn last_token_usage, not the cumulative totals", async () => {
    writeRollout(sessionId(1), [
      metaRecord(sessionId(1), workspace),
      turnContext("gpt-5"),
      tokenCount("2026-04-19T11:23:02.000Z", {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 10,
      }),
      tokenCount("2026-04-19T11:23:03.000Z", {
        input_tokens: 200,
        cached_input_tokens: 0,
        output_tokens: 20,
      }),
    ]);

    const snap = await codexUsageReader.getSessionUsage(sessionId(1), workspace);

    assert.ok(snap);
    assert.equal(snap.modelFallback, "gpt-5");
    assert.deepEqual(
      snap.turns.map((t) => [t.inputTokens, t.cacheReadTokens, t.outputTokens]),
      [
        [100, 40, 10],
        [200, 0, 20],
      ],
    );
  });

  it("returns an empty turn list for a subagent rollout", async () => {
    writeRollout(sessionId(1), [
      metaRecord(sessionId(1), workspace, { parent_thread_id: sessionId(99) }),
      turnContext("gpt-5"),
      tokenCount("2026-04-19T11:23:02.000Z", { input_tokens: 100, output_tokens: 10 }),
    ]);

    const snap = await codexUsageReader.getSessionUsage(sessionId(1), workspace);

    assert.ok(snap);
    assert.deepEqual(snap.turns, []);
  });

  it("finds a rollout by its session_meta id when the file name doesn't carry it", async () => {
    writeRollout(
      sessionId(1),
      [
        metaRecord(sessionId(1), workspace),
        turnContext("gpt-5"),
        tokenCount("2026-04-19T11:23:02.000Z", { input_tokens: 5 }),
      ],
      "rollout-renamed.jsonl",
    );

    const snap = await codexUsageReader.getSessionUsage(sessionId(1), workspace);

    assert.deepEqual(
      snap?.turns.map((t) => t.inputTokens),
      [5],
    );
  });

  it("returns null for an unknown session", async () => {
    assert.equal(await codexUsageReader.getSessionUsage(sessionId(1), workspace), null);
  });
});

describe("codexUsageReader file descriptors", () => {
  it("closes every rollout it opens across repeated scans", async () => {
    // Several lines per file so the readers stop before EOF (EOF would
    // auto-close the stream and hide a leak).
    const filler = Array.from({ length: 50 }, (_, i) =>
      tokenCount("2026-04-19T11:23:02.000Z", { input_tokens: i }),
    );
    for (let n = 1; n <= 30; n++) {
      writeRollout(sessionId(n), [metaRecord(sessionId(n), workspace), ...filler]);
    }
    // Subagent rollout: getSessionUsage breaks out after session_meta.
    writeRollout(sessionId(100), [
      metaRecord(sessionId(100), workspace, { parent_thread_id: sessionId(1) }),
      ...filler,
    ]);
    // Rollouts with no id in the name force findRolloutFile's session_meta scan.
    for (let n = 200; n < 210; n++) {
      writeRollout(
        sessionId(n),
        [metaRecord(sessionId(n), workspace), ...filler],
        `rollout-${n}.jsonl`,
      );
    }

    const baseline = openFdCount();
    for (let scan = 0; scan < 3; scan++) {
      // A fresh mtime each scan so listSessions rereads every file.
      const t = 1_000 + scan;
      for (const f of readdirSync(dayDir)) utimesSync(join(dayDir, f), t, t);
      // Before listSessions, so findRolloutFile's scan runs on a cold cache.
      await codexUsageReader.getSessionUsage(sessionId(209), workspace);
      await codexUsageReader.listSessions(workspace);
      await codexUsageReader.getSessionUsage(sessionId(100), workspace);
    }

    const settled = await settledFdCount(baseline);
    assert.equal(settled, baseline, `${settled - baseline} fd(s) still open 1 s after the scans`);
  });
});
