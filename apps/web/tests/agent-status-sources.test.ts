// Workspace agent status from several agents at once.
//
// Every agent reporting into a workspace keeps its own status: each chat
// pane's ACP turns, and each hook-reporting CLI session (`statuses.notify`,
// what `band notify` posts). The workspace status the dashboard shows is
// derived from all of them, needs_attention over working over waiting, so
// one agent never overwrites another. Chats run against the scripted stub
// agent (`tests/fixtures/acp-stub-agent.mjs`).

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openStream,
  runTurn,
  seedAcpHome,
  sendMessage,
  startAcpServer,
  TEST_TOKEN,
  trpc,
  turnEnded,
  WORKSPACE_ID,
} from "./helpers/acp-chat";
import { seedSettings } from "./helpers/seed-state";
import type { ServerHandle } from "./helpers/server";

let seq = 0;
const newChatId = () => `status-chat-${Date.now()}-${seq++}`;

async function workspaceStatus(url: string): Promise<string | undefined> {
  const data = await trpc<{ agent?: { status: string } } | null>(
    url,
    "statuses.get",
    { workspaceId: WORKSPACE_ID },
    "query",
  );
  return data?.agent?.status;
}

async function notify(url: string, input: Record<string, unknown>): Promise<void> {
  await trpc(url, "statuses.notify", input);
}

async function clearAttention(url: string): Promise<void> {
  await trpc(url, "statuses.clearNeedsAttention", { workspaceId: WORKSPACE_ID });
}

/** A Claude Code hook payload, as Claude Code pipes it to `band notify`. */
function claudeHook(repo: string, sessionId: string, fields: Record<string, unknown>) {
  return {
    session_id: sessionId,
    transcript_path: join(repo, ".home", ".claude", "projects", "-repo", `${sessionId}.jsonl`),
    cwd: repo,
    ...fields,
  };
}

describe("workspace status from chats and hook sessions", () => {
  let server: ServerHandle;
  let repo: string;

  beforeAll(async () => {
    server = await startAcpServer({
      turns: [
        { match: "^fail", steps: [{ fail: "the model is overloaded" }] },
        { match: "^long", steps: [{ say: "Working." }, { waitForCancel: true }] },
        {
          match: "^ask",
          steps: [
            {
              permission: {
                toolCall: { toolCallId: "run-1", title: "Run tests", kind: "execute" },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
              },
            },
          ],
        },
        { steps: [{ say: "Done." }] },
      ],
    });
    repo = join(server.home, "repo");
  });

  afterAll(async () => {
    await server?.close();
  });

  /**
   * Starts a turn that runs until `session/cancel`. Resolves once the agent
   * has replied, so a stop reaches it as a cancel rather than racing the
   * prompt. `done` settles when the turn ends (wrapped, because an async
   * function would adopt a returned promise and wait for it).
   */
  async function startLongTurn(chatId: string) {
    let replied!: () => void;
    const inTurn = new Promise<void>((resolve) => {
      replied = resolve;
    });
    const stream = await openStream(server.url, chatId, {
      until: turnEnded,
      onEvent: (e) => {
        if (e.type === "update" && e.update.sessionUpdate === "agent_message_chunk") replied();
      },
    });
    await sendMessage(server.url, chatId, "long task");
    await inTurn;
    return { done: stream.events };
  }

  it("a failed chat turn asks for attention", async () => {
    const chatId = newChatId();
    const events = await runTurn(server.url, chatId, "fail please");
    expect(events.find(turnEnded)).toMatchObject({
      error: "Claude Code: the model is overloaded",
    });

    expect(await workspaceStatus(server.url)).toBe("needs_attention");

    await clearAttention(server.url);
    expect(await workspaceStatus(server.url)).toBe("waiting");
  });

  it("a chat turn the user stopped does not ask for attention", async () => {
    const chatId = newChatId();
    const { done } = await startLongTurn(chatId);
    expect(await workspaceStatus(server.url)).toBe("working");
    await trpc(server.url, "tasks.abort", { workspaceId: WORKSPACE_ID, chatId });
    await done;

    expect(await workspaceStatus(server.url)).toBe("waiting");
  });

  it("a hook session starting work does not hide a chat that finished", async () => {
    const chatId = newChatId();
    await runTurn(server.url, chatId, "hello");
    expect(await workspaceStatus(server.url)).toBe("needs_attention");

    // A Claude Code in a terminal takes a prompt. Before, its `working`
    // overwrote the chat's needs_attention.
    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: claudeHook(repo, "session-a", { hook_event_name: "UserPromptSubmit" }),
    });
    expect(await workspaceStatus(server.url)).toBe("needs_attention");

    // Acknowledging clears the chat; the hook session is still working.
    await clearAttention(server.url);
    expect(await workspaceStatus(server.url)).toBe("working");

    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: claudeHook(repo, "session-a", { hook_event_name: "Stop" }),
    });
    expect(await workspaceStatus(server.url)).toBe("needs_attention");

    await clearAttention(server.url);
    expect(await workspaceStatus(server.url)).toBe("waiting");
  });

  it("a running chat stays working after a hook session's attention is acknowledged", async () => {
    const chatId = newChatId();
    const { done } = await startLongTurn(chatId);

    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: claudeHook(repo, "session-b", { hook_event_name: "Stop" }),
    });
    expect(await workspaceStatus(server.url)).toBe("needs_attention");

    await clearAttention(server.url);
    expect(await workspaceStatus(server.url)).toBe("working");

    await trpc(server.url, "tasks.abort", { workspaceId: WORKSPACE_ID, chatId });
    await done;
    expect(await workspaceStatus(server.url)).toBe("waiting");
  });

  it("two hook sessions in one workspace keep their own status", async () => {
    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: claudeHook(repo, "session-c", { hook_event_name: "Stop" }),
    });
    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: claudeHook(repo, "session-d", { hook_event_name: "PreToolUse", tool_name: "Read" }),
    });
    expect(await workspaceStatus(server.url)).toBe("needs_attention");

    await clearAttention(server.url);
    expect(await workspaceStatus(server.url)).toBe("working");

    // Claude Code exiting ends session-d's status.
    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: claudeHook(repo, "session-d", { hook_event_name: "SessionEnd" }),
    });
    expect(await workspaceStatus(server.url)).toBe("waiting");
  });

  it("acknowledging keeps a chat that waits on a permission answer", async () => {
    const chatId = newChatId();
    const stream = await openStream(server.url, chatId, { until: turnEnded });
    await sendMessage(server.url, chatId, "ask first");
    await expect.poll(() => workspaceStatus(server.url)).toBe("needs_attention");

    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: claudeHook(repo, "session-e", { hook_event_name: "Stop" }),
    });

    await clearAttention(server.url);
    expect(await workspaceStatus(server.url)).toBe("needs_attention");

    // Stopping the turn resolves the permission. The hook session was
    // acknowledged by the clear above, so nothing asks for attention now.
    await trpc(server.url, "tasks.abort", { workspaceId: WORKSPACE_ID, chatId });
    await stream.events;
    expect(await workspaceStatus(server.url)).toBe("waiting");
  });

  it("removing a chat drops its status", async () => {
    const chatId = newChatId();
    await runTurn(server.url, chatId, "hello");
    expect(await workspaceStatus(server.url)).toBe("needs_attention");

    await trpc(server.url, "chats.remove", { chatId });
    await expect.poll(() => workspaceStatus(server.url)).toBe("waiting");
  });

  it("closing a terminal drops the status of the hook session inside it", async () => {
    const terminalId = randomUUID();
    mkdirSync(repo, { recursive: true });
    await trpc(server.url, "terminal.create", { workspaceId: WORKSPACE_ID, id: terminalId });

    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      dispatch: "terminal",
      terminalId,
      payload: claudeHook(repo, "session-f", { hook_event_name: "PreToolUse", tool_name: "Bash" }),
    });
    expect(await workspaceStatus(server.url)).toBe("working");

    await trpc(server.url, "terminal.kill", { terminalId });
    await expect.poll(() => workspaceStatus(server.url)).toBe("waiting");
  });

  it("a Band terminal tells its agents which terminal they run in", async () => {
    const terminalId = randomUUID();
    mkdirSync(repo, { recursive: true });
    await trpc(server.url, "terminal.create", {
      workspaceId: WORKSPACE_ID,
      id: terminalId,
      command: `printf 'TERMINAL_ID:%s|\\n' "$BAND_TERMINAL_ID"`,
    });

    await expect
      .poll(async () => {
        const { output } = await trpc<{ output: string }>(
          server.url,
          "terminal.output",
          { terminalId },
          "query",
        );
        return output;
      })
      .toContain(`TERMINAL_ID:${terminalId}|`);

    await trpc(server.url, "terminal.kill", { terminalId });
  });

  it("ignores hooks from a chat pane's agent, whose turn already reports its status", async () => {
    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      dispatch: "chat",
      payload: claudeHook(repo, "session-g", { hook_event_name: "Stop" }),
    });
    expect(await workspaceStatus(server.url)).toBe("waiting");
  });

  it("rejects statuses.clearNeedsAttention without the band_token cookie (401)", async () => {
    const res = await fetch(`${server.url}/trpc/statuses.clearNeedsAttention`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID }),
    });
    expect(res.status).toBe(401);
  });
});

describe("hooks are read with the sending agent's rules", () => {
  let server: ServerHandle;
  let home: string;
  let repo: string;

  beforeAll(async () => {
    // The workspace's agent is Codex; the hooks come from Claude Code.
    home = seedAcpHome("band-status-codex-");
    seedSettings(home, {
      tokenSecret: TEST_TOKEN,
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code" },
        { id: "codex", type: "codex", label: "Codex" },
      ],
      defaultCodingAgent: "codex",
    });
    repo = join(home, "repo");
    server = await startAcpServer({ home });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a Claude Code Stop hook from an installed `--agent claude-code` hook asks for attention", async () => {
    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: { session_id: "flagged", cwd: repo, hook_event_name: "PostToolUse" },
    });
    expect(await workspaceStatus(server.url)).toBe("working");

    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: { session_id: "flagged", cwd: repo, hook_event_name: "Stop" },
    });
    expect(await workspaceStatus(server.url)).toBe("needs_attention");

    await clearAttention(server.url);
  });

  it("a hook installed before `--agent` is recognised as Claude Code from its payload", async () => {
    await notify(server.url, {
      cwd: repo,
      payload: claudeHook(repo, "unflagged", { hook_event_name: "PostToolUse" }),
    });
    expect(await workspaceStatus(server.url)).toBe("working");

    await notify(server.url, {
      cwd: repo,
      payload: claudeHook(repo, "unflagged", { hook_event_name: "Stop" }),
    });
    expect(await workspaceStatus(server.url)).toBe("needs_attention");

    await clearAttention(server.url);
    expect(await workspaceStatus(server.url)).toBe("waiting");
  });

  it("falls back to the workspace's agent when the sender is unknown", async () => {
    // Codex has no hook mapping, so any hook it sends means `working`.
    await notify(server.url, {
      cwd: repo,
      payload: { session_id: "unknown-sender", cwd: repo, hook_event_name: "Stop" },
    });
    expect(await workspaceStatus(server.url)).toBe("working");
  });
});

describe("server restart", () => {
  it("drops every agent's status, so a later hook can't bring back an old one", async () => {
    const home = seedAcpHome("band-status-restart-");
    const repo = join(home, "repo");
    try {
      let server = await startAcpServer({ home });
      await notify(server.url, {
        cwd: repo,
        agent: "claude-code",
        payload: claudeHook(repo, "before-restart", { hook_event_name: "Stop" }),
      });
      expect(await workspaceStatus(server.url)).toBe("needs_attention");
      await server.close();

      server = await startAcpServer({ home });
      try {
        await expect.poll(() => workspaceStatus(server.url)).toBe("waiting");
        await notify(server.url, {
          cwd: repo,
          agent: "claude-code",
          payload: claudeHook(repo, "after-restart", {
            hook_event_name: "PreToolUse",
            tool_name: "Read",
          }),
        });
        expect(await workspaceStatus(server.url)).toBe("working");
      } finally {
        await server.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("tab statuses", () => {
  let server: ServerHandle;
  let repo: string;

  beforeAll(async () => {
    server = await startAcpServer({
      turns: [
        { match: "^long", steps: [{ say: "Working." }, { waitForCancel: true }] },
        { steps: [{ say: "Done." }] },
      ],
    });
    repo = join(server.home, "repo");
    mkdirSync(repo, { recursive: true });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function tabStatuses(): Promise<unknown[] | undefined> {
    const data = await trpc<{ tabStatuses?: unknown[] } | null>(
      server.url,
      "statuses.get",
      { workspaceId: WORKSPACE_ID },
      "query",
    );
    return data?.tabStatuses;
  }

  it("lists a running chat as working, then drops it when the user stops it", async () => {
    const chatId = newChatId();
    let replied!: () => void;
    const inTurn = new Promise<void>((resolve) => {
      replied = resolve;
    });
    const stream = await openStream(server.url, chatId, {
      until: turnEnded,
      onEvent: (e) => {
        if (e.type === "update" && e.update.sessionUpdate === "agent_message_chunk") replied();
      },
    });
    await sendMessage(server.url, chatId, "long task");
    await inTurn;

    expect(await tabStatuses()).toEqual([{ chatId, status: "working" }]);

    await trpc(server.url, "tasks.abort", { workspaceId: WORKSPACE_ID, chatId });
    await stream.events;
    expect(await tabStatuses()).toEqual([]);
  });

  it("lists a finished chat as needing attention until the user acknowledges it", async () => {
    const chatId = newChatId();
    await runTurn(server.url, chatId, "hello");

    expect(await tabStatuses()).toEqual([{ chatId, status: "needs_attention" }]);

    await clearAttention(server.url);
    expect(await tabStatuses()).toEqual([]);
  });

  it("lists a terminal by the most urgent hook session running in it", async () => {
    const terminalId = randomUUID();
    await trpc(server.url, "terminal.create", { workspaceId: WORKSPACE_ID, id: terminalId });

    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      dispatch: "terminal",
      terminalId,
      payload: claudeHook(repo, "tab-a", { hook_event_name: "PreToolUse", tool_name: "Bash" }),
    });
    expect(await tabStatuses()).toEqual([{ terminalId, status: "working" }]);

    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      dispatch: "terminal",
      terminalId,
      payload: claudeHook(repo, "tab-b", { hook_event_name: "Stop" }),
    });
    expect(await tabStatuses()).toEqual([{ terminalId, status: "needs_attention" }]);

    await trpc(server.url, "terminal.kill", { terminalId });
    await expect.poll(() => tabStatuses()).toEqual([]);
  });

  it("leaves out a hook session that runs outside a Band terminal", async () => {
    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: claudeHook(repo, "tab-c", { hook_event_name: "PreToolUse", tool_name: "Read" }),
    });
    expect(await workspaceStatus(server.url)).toBe("working");
    expect(await tabStatuses()).toEqual([]);

    await notify(server.url, {
      cwd: repo,
      agent: "claude-code",
      payload: claudeHook(repo, "tab-c", { hook_event_name: "SessionEnd" }),
    });
  });
});
