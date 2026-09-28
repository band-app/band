/**
 * Tests for the Claude Code usage reader (`src/usage/claude-code.ts`), which
 * the Reports scanner uses to list a workspace's sessions and read their
 * token usage straight from `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/`.
 *
 * Real temp directories only: each test writes session JSONL files in the
 * layout Claude Code produces and points `CLAUDE_CONFIG_DIR` at the sandbox.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { claudeCodeUsageReader, encodeClaudeProjectDir } from "../src/usage/claude-code.ts";

const SESSION_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SESSION_B = "bbbbbbbb-2222-4222-8222-222222222222";
const SESSION_OTHER_CWD = "cccccccc-3333-4333-8333-333333333333";
const SESSION_SIDECHAIN = "dddddddd-4444-4444-8444-444444444444";

let root: string;
let workspace: string;
let projectDir: string;
let originalConfigDir: string | undefined;

function writeSession(sessionId: string, records: object[], mtimeMs?: number): void {
  const file = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

function userRecord(cwd: string, timestamp: string, extra: object = {}): object {
  return {
    type: "user",
    uuid: `u-${timestamp}`,
    cwd,
    timestamp,
    message: { content: "hi" },
    ...extra,
  };
}

function assistantRecord(
  messageId: string,
  timestamp: string,
  usage: object,
  extra: object = {},
): object {
  return {
    type: "assistant",
    uuid: `a-${messageId}-${timestamp}`,
    cwd: workspace,
    timestamp,
    message: { id: messageId, model: "claude-sonnet-4-6", usage },
    ...extra,
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "band-claude-usage-")));
  workspace = join(root, "workspaces", "my.repo");
  mkdirSync(workspace, { recursive: true });
  projectDir = join(root, "config", "projects", encodeClaudeProjectDir(workspace));
  mkdirSync(projectDir, { recursive: true });
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
});

afterEach(() => {
  if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  else delete process.env.CLAUDE_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("encodeClaudeProjectDir", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    assert.equal(encodeClaudeProjectDir("/Users/me/my.repo_x"), "-Users-me-my-repo-x");
  });

  it("truncates names over 200 characters and appends a base36 hash", () => {
    const encoded = encodeClaudeProjectDir(`/${"a".repeat(250)}`);
    assert.match(encoded, /^-a{199}-[0-9a-z]+$/);
  });
});

describe("claudeCodeUsageReader.listSessions", () => {
  it("returns sessions recorded in the workspace's cwd with their mtime", async () => {
    writeSession(SESSION_A, [userRecord(workspace, "2026-01-01T10:00:00.000Z")], 1_700_000_000_000);
    writeSession(SESSION_B, [userRecord(workspace, "2026-01-02T10:00:00.000Z")], 1_700_000_500_000);

    const sessions = await claudeCodeUsageReader.listSessions(workspace);

    assert.deepEqual(sessions, [
      { sessionId: SESSION_B, lastModified: 1_700_000_500_000 },
      { sessionId: SESSION_A, lastModified: 1_700_000_000_000 },
    ]);
  });

  it("skips other cwds, sidechain transcripts and non-session files", async () => {
    writeSession(SESSION_A, [userRecord(workspace, "2026-01-01T10:00:00.000Z")]);
    // A different cwd that encodes to the same directory name.
    writeSession(SESSION_OTHER_CWD, [
      userRecord(join(root, "workspaces", "my-repo"), "2026-01-01T10:00:00.000Z"),
    ]);
    writeSession(SESSION_SIDECHAIN, [
      userRecord(workspace, "2026-01-01T10:00:00.000Z", { isSidechain: true }),
    ]);
    writeFileSync(join(projectDir, "not-a-session.jsonl"), "{}\n");
    writeFileSync(join(projectDir, `${SESSION_B}.jsonl`), "");

    const sessions = await claudeCodeUsageReader.listSessions(workspace);

    assert.deepEqual(
      sessions.map((s) => s.sessionId),
      [SESSION_A],
    );
  });

  it("returns an empty list when the workspace has no project directory", async () => {
    const sessions = await claudeCodeUsageReader.listSessions(join(root, "elsewhere"));
    assert.deepEqual(sessions, []);
  });
});

describe("claudeCodeUsageReader.getSessionUsage", () => {
  it("counts each API message once even when it spans several content-block records", async () => {
    const usage1 = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 };
    const usage2 = { input_tokens: 20, output_tokens: 200, cache_creation_input_tokens: 50 };
    writeSession(SESSION_A, [
      userRecord(workspace, "2026-01-01T10:00:00.000Z"),
      assistantRecord("msg_1", "2026-01-01T10:00:01.000Z", usage1),
      assistantRecord("msg_1", "2026-01-01T10:00:02.000Z", usage1),
      assistantRecord("msg_2", "2026-01-01T10:00:05.000Z", usage2),
      // Structural record with no tokens: not a billable round-trip.
      assistantRecord("msg_3", "2026-01-01T10:00:06.000Z", { input_tokens: 0, output_tokens: 0 }),
      // Subagent record: excluded like the SDK's transcript reader does.
      assistantRecord("msg_4", "2026-01-01T10:00:07.000Z", usage2, { isSidechain: true }),
    ]);

    const snap = await claudeCodeUsageReader.getSessionUsage(SESSION_A, workspace);

    assert.ok(snap);
    assert.equal(snap.sessionId, SESSION_A);
    assert.equal(snap.modelFallback, "claude-sonnet-4-6");
    assert.equal(snap.startedAt, Date.parse("2026-01-01T10:00:00.000Z"));
    assert.equal(snap.updatedAt, Date.parse("2026-01-01T10:00:06.000Z"));
    assert.deepEqual(
      snap.turns.map((t) => [
        t.turnIndex,
        t.capturedAt,
        t.inputTokens,
        t.outputTokens,
        t.cacheReadTokens,
        t.cacheCreationTokens,
      ]),
      [
        [0, Date.parse("2026-01-01T10:00:02.000Z"), 10, 100, 1000, 0],
        [1, Date.parse("2026-01-01T10:00:05.000Z"), 20, 200, 0, 50],
      ],
    );
    assert.ok(snap.turns.every((t) => t.costUsd > 0));
  });

  it("returns null for a missing session or a non-UUID id", async () => {
    assert.equal(await claudeCodeUsageReader.getSessionUsage(SESSION_B, workspace), null);
    assert.equal(await claudeCodeUsageReader.getSessionUsage("../etc/passwd", workspace), null);
  });
});
