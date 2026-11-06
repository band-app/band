// Integration tests for quick commands: the hub table behind the tab bar menu, Settings and the
// phone. Real production server and SQLite. The agent case runs the scripted ACP stub: a stored
// agent command is launched the way a client runs it (`agentSessions.launch` with its agent and
// prompt) and the prompt reaches the agent as the chat's first message.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAcpServer, stubRequests, TEST_TOKEN, trpc, WORKTREE_ID } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle } from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

interface Command {
  id: string;
  label: string;
  repo: string | null;
  action: "terminal" | "agent";
  command?: string;
  appendEnter?: boolean;
  agentId?: string;
  prompt?: string;
  lastRunAt: number | null;
}

const list = async (url: string) =>
  (await trpc<{ commands: Command[] }>(url, "quickCommands.list", undefined, "query")).commands;

describe("quickCommands", () => {
  let server: ServerHandle;
  let home: string;

  beforeAll(async () => {
    home = createTmpHome("band-quick-commands-");
    const dirs = ["a", "b"].map((n) => {
      const dir = join(home, n);
      mkdirSync(dir, { recursive: true });
      return dir;
    });
    seedState(home, {
      repos: [
        {
          name: "testrepo",
          path: dirs[0],
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: dirs[0] }],
        },
        { name: "other", path: dirs[1], defaultBranch: "main" },
      ],
    });
    seedSettings(home, {
      tokenSecret: TEST_TOKEN,
      codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
      defaultCodingAgent: "claude-code",
    });
    server = await startAcpServer({ home });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(home);
  });

  it("refuses a request without the token", async () => {
    const res = await fetch(`${server.url}/trpc/quickCommands.list`);
    expect(res.status).toBe(401);
  });

  it("saves a terminal command scoped to a repo and lists it", async () => {
    const { command } = await trpc<{ command: Command }>(server.url, "quickCommands.create", {
      label: "Start dev server",
      repo: "testrepo",
      action: "terminal",
      command: "npm run dev",
      appendEnter: true,
    });
    expect(command).toMatchObject({
      label: "Start dev server",
      repo: "testrepo",
      action: "terminal",
      command: "npm run dev",
      appendEnter: true,
    });
    expect((await list(server.url)).map((c) => c.id)).toContain(command.id);
  });

  it("updates and deletes a command", async () => {
    const { command } = await trpc<{ command: Command }>(server.url, "quickCommands.create", {
      label: "Temp",
      repo: null,
      action: "terminal",
      command: "ls",
      appendEnter: false,
    });
    const updated = await trpc<{ command: Command }>(server.url, "quickCommands.update", {
      id: command.id,
      command: {
        label: "Temp 2",
        repo: null,
        action: "terminal",
        command: "ls -la",
        appendEnter: false,
      },
    });
    expect(updated.command).toMatchObject({
      label: "Temp 2",
      command: "ls -la",
      appendEnter: false,
    });
    await trpc(server.url, "quickCommands.remove", { id: command.id });
    expect((await list(server.url)).map((c) => c.id)).not.toContain(command.id);
    await expect(trpc(server.url, "quickCommands.remove", { id: command.id })).rejects.toThrow(
      /\(404\)/,
    );
  });

  it("orders the most recently run first, then by label", async () => {
    const make = (label: string) =>
      trpc<{ command: Command }>(server.url, "quickCommands.create", {
        label,
        repo: null,
        action: "terminal",
        command: "true",
        appendEnter: true,
      }).then((r) => r.command);
    const zed = await make("Zed order");
    await make("Alpha order");
    await trpc(server.url, "quickCommands.markRun", { id: zed.id });
    const labels = (await list(server.url)).map((c) => c.label).filter((l) => l.endsWith("order"));
    expect(labels).toEqual(["Zed order", "Alpha order"]);
  });

  describe("validation", () => {
    const refused = (input: object, message: RegExp) =>
      expect(trpc(server.url, "quickCommands.create", input)).rejects.toThrow(message);
    const terminal = {
      label: "x",
      repo: null,
      action: "terminal",
      command: "ls",
      appendEnter: true,
    };

    it("refuses an empty label or body", async () => {
      await refused({ ...terminal, label: "  " }, /\(400\).*Label is required/);
      await refused({ ...terminal, command: " " }, /\(400\).*Command is required/);
      await refused(
        { label: "x", repo: null, action: "agent", agentId: "claude-code", prompt: "" },
        /\(400\).*Prompt is required/,
      );
    });

    it("refuses text over the limits", async () => {
      await refused({ ...terminal, label: "a".repeat(81) }, /\(400\).*at most 80/);
      await refused({ ...terminal, command: "a".repeat(4001) }, /\(400\).*at most 4000/);
    });

    it("refuses an unknown repo or agent", async () => {
      await refused({ ...terminal, repo: "nope" }, /\(400\).*Unknown repo/);
      await refused(
        { label: "x", repo: null, action: "agent", agentId: "ghost", prompt: "hi" },
        /\(400\).*Unknown agent/,
      );
    });
  });

  it("starts the chosen agent with the saved prompt", async () => {
    const { command } = await trpc<{ command: Command }>(server.url, "quickCommands.create", {
      label: "Say hi",
      repo: "testrepo",
      action: "agent",
      agentId: "claude-code",
      prompt: "say hi",
    });
    // A client reads the command and launches it in the worktree.
    const saved = (await list(server.url)).find((c) => c.id === command.id);
    expect(saved).toMatchObject({ agentId: "claude-code", prompt: "say hi" });
    const result = await trpc<{ mode: string; chatId?: string }>(
      server.url,
      "agentSessions.launch",
      { worktreeId: WORKTREE_ID, agentId: saved?.agentId, prompt: saved?.prompt, mode: "gui" },
    );
    expect(result.mode).toBe("gui");
    await waitFor(
      () =>
        stubRequests(home, "session/prompt").some(
          (r) => (r.params.prompt as { text?: string }[])[0]?.text === "say hi",
        ),
      { label: "prompt reached the ACP agent" },
    );
  });

  it("removing a repo deletes its commands and keeps the global ones", async () => {
    const make = (label: string, repo: string | null) =>
      trpc<{ command: Command }>(server.url, "quickCommands.create", {
        label,
        repo,
        action: "terminal",
        command: "true",
        appendEnter: true,
      }).then((r) => r.command);
    const scoped = await make("Only other", "other");
    const global = await make("Everywhere", null);
    await trpc(server.url, "repos.remove", { name: "other" });
    const ids = (await list(server.url)).map((c) => c.id);
    expect(ids).not.toContain(scoped.id);
    expect(ids).toContain(global.id);
  });
});
