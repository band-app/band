/**
 * What Claude Code's "Default" model and effort choices resolve to
 * (`SessionState.resolvedDefaults`), so the composer can name them.
 *
 * Real server, the ACP stub agent as the only stub. The stub advertises the
 * Claude adapter's shape: a `default` row in the model and effort options.
 * The server resolves those rows from, in order: the session's Claude Code
 * transcript under `$HOME/.claude/projects/`, the environment and settings
 * files (`$HOME/.claude/settings.json`, the repo's `.claude/` files, a
 * `--settings` file on the CLI's command line), then what an earlier session
 * of the agent reported. `BAND_TEST_ACP_CLI_ARGS` makes the stub start a
 * stand-in CLI process whose command line carries a wrapper's flags.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedDefaults } from "@band-app/shared/chat-events";
import { afterEach, describe, expect, it } from "vitest";
import { maxId, runTurn, seedAcpHome, startAcpServer, trpc, WORKTREE_ID } from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";

let servers: ServerHandle[] = [];
let homes: string[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/** The Claude adapter's options: `default` rows for model and effort. */
const CLAUDE_OPTIONS = {
  models: [
    { value: "default", name: "Default (recommended)", description: "Opus (1M context)" },
    { value: "opus[1m]", name: "Opus 5.5", description: "Opus 5.5 with 1M context" },
    { value: "sonnet", name: "Sonnet 5", description: "Sonnet 5" },
  ],
  extra: [
    {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      options: [
        { value: "default", name: "Default" },
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ],
};

/** Keeps the test runner's own Claude Code environment out of the server. */
const CLEAN_ENV = { CLAUDE_CONFIG_DIR: "", ANTHROPIC_MODEL: "", CLAUDE_CODE_EFFORT_LEVEL: "" };

async function boot(home: string, env: Record<string, string> = {}) {
  const server = await startAcpServer({
    home,
    env: { ...CLEAN_ENV, BAND_TEST_ACP_OPTIONS: JSON.stringify(CLAUDE_OPTIONS), ...env },
  });
  servers.push(server);
  return server;
}

function home(): string {
  const h = seedAcpHome("band-claude-defaults-");
  homes.push(h);
  return h;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** Writes a Claude Code transcript for the session, the way the CLI does:
 *  one JSON line per record, the assistant ones naming model and effort. */
function writeTranscript(
  h: string,
  sessionId: string,
  records: { model: string; effort: string; at: Date; sidechain?: boolean }[],
): void {
  const dir = join(h, ".claude", "projects", join(h, "repo").replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const lines = records.map((r) =>
    JSON.stringify({
      type: "assistant",
      isSidechain: r.sidechain ?? false,
      timestamp: r.at.toISOString(),
      effort: r.effort,
      sessionId,
      message: { role: "assistant", model: r.model, content: [] },
    }),
  );
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

async function sessionState(url: string, chatId: string) {
  const { state } = await trpc<{
    state: {
      resolvedDefaults?: ResolvedDefaults;
      configOptions: { id: string; currentValue: string }[];
    };
  }>(url, "chats.sessionState", { chatId }, "query");
  return state;
}

async function activeSessionId(url: string, chatId: string): Promise<string> {
  const { chat } = await trpc<{ chat: { activeSessionId?: string } | null }>(
    url,
    "chats.get",
    { chatId },
    "query",
  );
  if (!chat?.activeSessionId) throw new Error("chat has no session");
  return chat.activeSessionId;
}

let seq = 0;
const newChatId = () => `claude-defaults-${Date.now()}-${seq++}`;

/** Managed Claude Code settings outrank every file a test writes, so a host
 *  that has them resolves differently. */
const HOST_HAS_MANAGED_SETTINGS = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
].some((path) => existsSync(path));

describe.skipIf(HOST_HAS_MANAGED_SETTINGS)("Claude Code resolved defaults", () => {
  it("refuses the session state without a token", async () => {
    const server = await boot(home());
    const input = encodeURIComponent(JSON.stringify({ chatId: newChatId() }));
    const res = await fetch(`${server.url}/trpc/chats.sessionState?input=${input}`);
    expect(res.status).toBe(401);
  });

  it("reads model and effort from the user and repo settings files", async () => {
    const h = home();
    writeJson(join(h, ".claude", "settings.json"), { model: "sonnet", effortLevel: "low" });
    writeJson(join(h, "repo", ".claude", "settings.json"), { effortLevel: "medium" });
    writeJson(join(h, "repo", ".claude", "settings.local.json"), {
      modelSettings: { "claude-sonnet-5": { effortLevel: "high" } },
    });
    const server = await boot(h);
    const chatId = newChatId();
    await trpc(server.url, "chats.create", { worktreeId: WORKTREE_ID, id: chatId });

    // Before the chat has a session.
    expect((await sessionState(server.url, chatId)).resolvedDefaults).toEqual({
      model: "sonnet",
      effort: "high",
    });
  });

  it("lets a settings env block and the environment set model and effort", async () => {
    const h = home();
    writeJson(join(h, ".claude", "settings.json"), {
      model: "sonnet",
      effortLevel: "low",
      env: { CLAUDE_CODE_EFFORT_LEVEL: "max" },
    });
    const server = await boot(h, { ANTHROPIC_MODEL: "claude-fable-5-1" });
    const chatId = newChatId();
    await trpc(server.url, "chats.create", { worktreeId: WORKTREE_ID, id: chatId });

    expect((await sessionState(server.url, chatId)).resolvedDefaults).toEqual({
      model: "claude-fable-5-1",
      effort: "max",
    });
  });

  it("reads a --settings file a wrapper put on the CLI's command line", async () => {
    const h = home();
    writeJson(join(h, ".claude", "settings.json"), { effortLevel: "low" });
    const wrapperSettings = join(h, "wrapper-settings.json");
    writeJson(wrapperSettings, { model: "opus[1m]", effortLevel: "high" });
    const server = await boot(h, {
      BAND_TEST_ACP_CLI_ARGS: JSON.stringify(["--settings", wrapperSettings]),
    });
    const chatId = newChatId();

    await runTurn(server.url, chatId, "hello");

    await expect
      .poll(async () => (await sessionState(server.url, chatId)).resolvedDefaults, {
        timeout: 10_000,
      })
      .toEqual({ model: "opus[1m]", effort: "high" });
  });

  it("prefers what the session's transcript reports, and pushes it when a turn ends", async () => {
    const h = home();
    writeJson(join(h, ".claude", "settings.json"), { effortLevel: "low" });
    const server = await boot(h);
    const chatId = newChatId();
    const first = await runTurn(server.url, chatId, "first");
    const sessionId = await activeSessionId(server.url, chatId);
    expect((await sessionState(server.url, chatId)).resolvedDefaults).toEqual({ effort: "low" });

    const now = Date.now();
    writeTranscript(h, sessionId, [
      { model: "claude-opus-5-5", effort: "medium", at: new Date(now) },
      // A subagent's record is not the session's model.
      { model: "claude-haiku-4-5", effort: "low", at: new Date(now + 1), sidechain: true },
    ]);
    const second = await runTurn(server.url, chatId, "second", maxId(first));

    const pushed = second.filter((e) => e.type === "session-state");
    expect(pushed.at(-1)).toMatchObject({
      type: "session-state",
      state: { resolvedDefaults: { model: "claude-opus-5-5", effort: "medium" } },
    });
    expect((await sessionState(server.url, chatId)).resolvedDefaults).toEqual({
      model: "claude-opus-5-5",
      effort: "medium",
    });
  });

  it("ignores transcript records from before the effort choice changed", async () => {
    const h = home();
    writeJson(join(h, ".claude", "settings.json"), { effortLevel: "low" });
    const server = await boot(h);
    const chatId = newChatId();
    await runTurn(server.url, chatId, "first");
    const sessionId = await activeSessionId(server.url, chatId);
    writeTranscript(h, sessionId, [
      { model: "claude-opus-5-5", effort: "high", at: new Date(Date.now() - 1000) },
    ]);
    expect((await sessionState(server.url, chatId)).resolvedDefaults).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
    });

    // Pinning High and going back to Default: the recorded High was the pin.
    await trpc(server.url, "chats.setConfigOption", { chatId, configId: "effort", value: "high" });
    await trpc(server.url, "chats.setConfigOption", {
      chatId,
      configId: "effort",
      value: "default",
    });

    expect((await sessionState(server.url, chatId)).resolvedDefaults).toEqual({ effort: "low" });
  });

  it("uses what an earlier session reported for a chat with no session yet", async () => {
    const h = home();
    const server = await boot(h);
    const chatId = newChatId();
    const first = await runTurn(server.url, chatId, "first");
    writeTranscript(h, await activeSessionId(server.url, chatId), [
      { model: "claude-opus-5-5", effort: "medium", at: new Date() },
    ]);
    await runTurn(server.url, chatId, "second", maxId(first));
    // Another chat starting a session rewrites the agent's catalog entry.
    await runTurn(server.url, newChatId(), "third");

    const fresh = newChatId();
    await trpc(server.url, "chats.create", { worktreeId: WORKTREE_ID, id: fresh });

    expect((await sessionState(server.url, fresh)).resolvedDefaults).toEqual({
      model: "claude-opus-5-5",
      effort: "medium",
    });
  });

  it("resolves nothing for other agents", async () => {
    const h = home();
    writeJson(join(h, ".claude", "settings.json"), { model: "sonnet", effortLevel: "low" });
    const server = await boot(h);
    const chatId = newChatId();
    await trpc(server.url, "chats.create", {
      worktreeId: WORKTREE_ID,
      id: chatId,
      agent: "codex",
    });
    await runTurn(server.url, chatId, "hello");

    const state = await sessionState(server.url, chatId);
    expect(state.configOptions.find((o) => o.id === "model")?.currentValue).toBe("default");
    expect(state.resolvedDefaults).toBeUndefined();
  });
});
