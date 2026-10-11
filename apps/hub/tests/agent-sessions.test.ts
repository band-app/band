// Integration tests for agent sessions and `agentSessions.launch` (issue #682).
//
// A launch starts a coding agent in the mode the caller sends: `gui` opens a
// chat and runs the prompt over ACP, `tui` spawns the agent's CLI in a
// terminal with the prompt as argv. Without a mode the server's
// `agents.defaultMode` applies, and boot migrates the pre-#682
// `cli.defaultVia` into it.
//
// Real production server, real PTYs, real SQLite. GUI sessions run the
// scripted ACP stub agent (`BAND_TEST_ACP_AGENT`); TUI sessions run a shell
// stub configured as the agent definition's `command` that echoes its argv.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionRecord } from "@band-app/shared/agent-sessions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAcpServer, stubRequests, TEST_TOKEN, trpc, WORKTREE_ID } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle } from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { waitFor } from "./helpers/wait-for";

interface LaunchResult {
  agentSession: AgentSessionRecord;
  mode: "gui" | "tui";
  chatId?: string;
  terminalId?: string;
  notice?: string;
}

/** A vendor CLI stub that prints `ARGV:<arg>|<arg>|…` and exits. */
function writeArgvStub(home: string): string {
  const path = join(home, "stub-agent-cli.sh");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf 'ARGV:'\nfor arg in "$@"; do printf '%s|' "$arg"; done\nprintf '\\n'\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

/** A git-less repo with one worktree, and settings with the given
 *  extras (`seedAcpHome` with its own agents). */
function seedHome(prefix: string, settings: (home: string) => object): string {
  const home = createTmpHome(prefix);
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  seedState(home, {
    repos: [
      {
        name: "testrepo",
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  seedSettings(home, { tokenSecret: TEST_TOKEN, ...settings(home) });
  return home;
}

function launch(url: string, input: object): Promise<LaunchResult> {
  return trpc<LaunchResult>(url, "agentSessions.launch", { worktreeId: WORKTREE_ID, ...input });
}

async function openSessions(url: string): Promise<AgentSessionRecord[]> {
  const data = await trpc<{ agentSessions: AgentSessionRecord[] }>(
    url,
    "agentSessions.list",
    { worktreeId: WORKTREE_ID },
    "query",
  );
  return data.agentSessions;
}

async function terminalOutput(url: string, terminalId: string): Promise<string | undefined> {
  try {
    const data = await trpc<{ output: string }>(url, "terminal.output", { terminalId }, "query");
    return data.output;
  } catch {
    return undefined;
  }
}

describe("agentSessions.launch", () => {
  let server: ServerHandle;
  let home: string;

  beforeAll(async () => {
    home = seedHome("band-agent-sessions-", (h) => {
      const cli = writeArgvStub(h);
      return {
        codingAgents: [
          { id: "claude-code", type: "claude-code", label: "Claude Code", command: cli },
          { id: "cursor-cli", type: "cursor-cli", label: "Cursor CLI" },
        ],
        defaultCodingAgent: "claude-code",
      };
    });
    server = await startAcpServer({ home });
  });

  afterAll(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("rejects a launch without the band_token cookie", async () => {
    const res = await fetch(`${server.url}/trpc/agentSessions.launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeId: WORKTREE_ID, mode: "gui" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns NOT_FOUND for an unknown worktree", async () => {
    await expect(
      trpc(server.url, "agentSessions.launch", {
        worktreeId: testWorktreeId("nope", "main"),
        mode: "gui",
      }),
    ).rejects.toThrow(/\(404\)/);
  });

  it("rejects a chat id that belongs to another worktree", async () => {
    await trpc(server.url, "chats.create", {
      worktreeId: testWorktreeId("other", "main"),
      id: "chat_other_ws",
    });
    await expect(launch(server.url, { mode: "gui", chatId: "chat_other_ws" })).rejects.toThrow(
      /\(400\).*not in worktree/,
    );
  });

  it("gui opens a chat, runs the prompt over ACP and records the provider session", async () => {
    const result = await launch(server.url, {
      mode: "gui",
      chatId: "chat_gui_launch",
      prompt: "hello from gui",
    });
    expect(result.mode).toBe("gui");
    expect(result.chatId).toBe("chat_gui_launch");
    expect(result.terminalId).toBeUndefined();
    expect(result.agentSession).toMatchObject({
      worktreeId: WORKTREE_ID,
      agentDefinitionId: "claude-code",
      mode: "gui",
      chatId: "chat_gui_launch",
      terminalId: null,
    });

    await waitFor(
      () =>
        stubRequests(home, "session/prompt").some(
          (r) => (r.params.prompt as { text?: string }[])[0]?.text === "hello from gui",
        ),
      { label: "prompt reached the ACP agent" },
    );

    // The chat's ACP session id becomes the agent session's provider id.
    const running = await waitFor(
      async () =>
        (await openSessions(server.url)).find(
          (s) => s.id === result.agentSession.id && s.state === "running",
        ),
      { label: "gui session running" },
    );
    const chat = await trpc<{ chat: { activeSessionId?: string } }>(
      server.url,
      "chats.get",
      { chatId: "chat_gui_launch" },
      "query",
    );
    expect(chat.chat.activeSessionId).toBeTruthy();
    expect(running.providerSessionId).toBe(chat.chat.activeSessionId);

    // Removing the chat ends its session.
    await trpc(server.url, "chats.remove", { chatId: "chat_gui_launch" });
    await waitFor(
      async () => !(await openSessions(server.url)).some((s) => s.id === result.agentSession.id),
      { label: "gui session ended" },
    );
  });

  it("tui spawns the agent's CLI in a terminal with the prompt as argv", async () => {
    const terminalId = "5b0e3f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const result = await launch(server.url, { mode: "tui", terminalId, prompt: "hello from tui" });
    expect(result.mode).toBe("tui");
    expect(result.terminalId).toBe(terminalId);
    expect(result.chatId).toBeUndefined();
    expect(result.agentSession).toMatchObject({
      worktreeId: WORKTREE_ID,
      agentDefinitionId: "claude-code",
      mode: "tui",
      terminalId,
      chatId: null,
      providerSessionId: null,
      state: "starting",
    });

    const output = await waitFor(
      async () => {
        const out = await terminalOutput(server.url, terminalId);
        return out?.includes("ARGV:hello from tui|") ? out : undefined;
      },
      { label: "agent CLI got the prompt" },
    );
    expect(output).toContain("ARGV:hello from tui|");

    const open = await openSessions(server.url);
    expect(open.map((s) => s.id)).toContain(result.agentSession.id);

    // Closing the terminal ends its session.
    await trpc(server.url, "terminal.kill", { terminalId });
    await waitFor(
      async () => !(await openSessions(server.url)).some((s) => s.id === result.agentSession.id),
      { label: "tui session ended" },
    );
  });

  it("tui without a prompt starts the CLI with no arguments", async () => {
    const terminalId = "6c1f4a7b-2d3e-4f60-9b0c-1d2e3f4a5b6c";
    const result = await launch(server.url, { mode: "tui", terminalId });
    expect(result.mode).toBe("tui");
    // The stub prints `ARGV:` and its closing newline with separate writes,
    // so a read can land between them. Wait for the line to end.
    const output = await waitFor(
      async () => {
        const out = await terminalOutput(server.url, terminalId);
        return out?.match(/ARGV:.*\r?\n/) ? out : undefined;
      },
      { label: "agent CLI started" },
    );
    expect(output).toMatch(/ARGV:\r?\n/);
    await trpc(server.url, "terminal.kill", { terminalId });
  });

  it("starts an agent without a TUI invocation in a chat, with a notice", async () => {
    const result = await launch(server.url, {
      mode: "tui",
      agentId: "cursor-cli",
      chatId: "chat_cursor_fallback",
    });
    expect(result.mode).toBe("gui");
    expect(result.chatId).toBe("chat_cursor_fallback");
    expect(result.terminalId).toBeUndefined();
    expect(result.notice).toMatch(/Cursor CLI/);
    expect(result.agentSession).toMatchObject({ mode: "gui", agentDefinitionId: "cursor-cli" });
  });

  it("uses agents.defaultMode when the caller sends no mode", async () => {
    await trpc(server.url, "settings.update", { agents: { defaultMode: "tui" } });
    const terminalId = "7d2a5b8c-3e4f-4a71-8c1d-2e3f4a5b6c7d";
    const tui = await launch(server.url, { terminalId, prompt: "default tui" });
    expect(tui.mode).toBe("tui");
    expect(tui.terminalId).toBe(terminalId);
    await trpc(server.url, "terminal.kill", { terminalId });

    await trpc(server.url, "settings.update", { agents: { defaultMode: "gui" } });
    const gui = await launch(server.url, { chatId: "chat_default_gui" });
    expect(gui.mode).toBe("gui");
    expect(gui.chatId).toBe("chat_default_gui");
  });
});

describe("agents.defaultMode migration", () => {
  let server: ServerHandle;
  let home: string;

  beforeAll(async () => {
    home = seedHome("band-agent-mode-migrate-", (h) => ({
      codingAgents: [
        {
          id: "claude-code",
          type: "claude-code",
          label: "Claude Code",
          command: writeArgvStub(h),
        },
      ],
      cli: { defaultVia: "terminal" },
    }));
    server = await startAcpServer({ home });
  });

  afterAll(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("copies cli.defaultVia into agents.defaultMode at boot and keeps the old key", async () => {
    const settings = await waitFor(
      async () => {
        const s = await trpc<{ agents?: { defaultMode?: string }; cli?: { defaultVia?: string } }>(
          server.url,
          "settings.get",
          undefined,
          "query",
        );
        return s.agents?.defaultMode ? s : undefined;
      },
      { label: "settings migrated" },
    );
    expect(settings.agents?.defaultMode).toBe("tui");
    expect(settings.cli?.defaultVia).toBe("terminal");

    const terminalId = "8e3b6c9d-4f5a-4b82-9d2e-3f4a5b6c7d8e";
    const result = await launch(server.url, { terminalId });
    expect(result.mode).toBe("tui");
    await trpc(server.url, "terminal.kill", { terminalId });
  });
});
