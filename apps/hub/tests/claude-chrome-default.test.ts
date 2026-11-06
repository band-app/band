// Integration test for the Claude in Chrome default. A real hub (production bundle, temp HOME)
// starts the scripted ACP stub as the claude-code agent. The stub records the variables named in
// BAND_TEST_ACP_LOG_ENV, and each case rewrites the temp HOME's ~/.claude.json before a chat starts.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAcpServer, stubRequests, TEST_TOKEN, trpc } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const WORKTREE = toWorktreeId("alpha", "main", "local");
let home: string;
let server: ServerHandle;
let count = 0;

async function agentEnvOf(agent: string, url = server.url, dir = home) {
  const chatId = `chat-${++count}`;
  await trpc(url, "chats.create", { worktreeId: WORKTREE, id: chatId, agent });
  const res = await fetch(`${url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId: WORKTREE, text: "hello" }),
  });
  expect(res.ok).toBe(true);
  const request = await waitFor(
    () => stubRequests(dir, "session/new").find((r) => r.env.BAND_CHAT_ID === chatId),
    { label: `agent of ${chatId} started` },
  );
  return request.env.NAMED?.CLAUDE_CODE_ENABLE_CFC ?? null;
}

const writeConfig = (content: string, dir = home) =>
  writeFileSync(join(dir, ".claude.json"), content);

beforeAll(async () => {
  home = createTmpHome("band-chrome-default-");
  const alpha = join(home, "alpha");
  mkdirSync(alpha, { recursive: true });
  seedState(home, {
    repos: [
      {
        name: "alpha",
        path: alpha,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: alpha }],
      },
    ],
  });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex" },
    ],
    defaultCodingAgent: "claude-code",
  });
  server = await startAcpServer({
    home,
    env: { BAND_SERVE_UI: "false", BAND_TEST_ACP_LOG_ENV: "CLAUDE_CODE_ENABLE_CFC" },
  });
});

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("claudeInChromeDefaultEnabled", () => {
  it("leaves the variable unset without a config file", async () => {
    expect(await agentEnvOf("claude-code")).toBeNull();
  });

  it("sets CLAUDE_CODE_ENABLE_CFC=1 when the setting is true, read at each launch", async () => {
    writeConfig(JSON.stringify({ claudeInChromeDefaultEnabled: true }));
    expect(await agentEnvOf("claude-code")).toBe("1");
    writeConfig(JSON.stringify({ claudeInChromeDefaultEnabled: false }));
    expect(await agentEnvOf("claude-code")).toBeNull();
  });

  it("stays off for an absent key, a non-true value and invalid JSON, and the chat still starts", async () => {
    writeConfig(JSON.stringify({ other: true }));
    expect(await agentEnvOf("claude-code")).toBeNull();
    writeConfig(JSON.stringify({ claudeInChromeDefaultEnabled: "true" }));
    expect(await agentEnvOf("claude-code")).toBeNull();
    writeConfig("{ not json");
    expect(await agentEnvOf("claude-code")).toBeNull();
  });

  it("does not set it for another agent", async () => {
    writeConfig(JSON.stringify({ claudeInChromeDefaultEnabled: true }));
    expect(await agentEnvOf("codex")).toBeNull();
  });
});

describe("a CLAUDE_CODE_ENABLE_CFC the worker already has", () => {
  it("wins over the config file", async () => {
    const userHome = createTmpHome("band-chrome-user-");
    const alpha = join(userHome, "alpha");
    mkdirSync(alpha, { recursive: true });
    seedState(userHome, {
      repos: [
        {
          name: "alpha",
          path: alpha,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: alpha }],
        },
      ],
    });
    seedSettings(userHome, {
      tokenSecret: TEST_TOKEN,
      codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
      defaultCodingAgent: "claude-code",
    });
    writeConfig(JSON.stringify({ claudeInChromeDefaultEnabled: true }), userHome);
    const own = await startAcpServer({
      home: userHome,
      env: {
        BAND_SERVE_UI: "false",
        BAND_TEST_ACP_LOG_ENV: "CLAUDE_CODE_ENABLE_CFC",
        CLAUDE_CODE_ENABLE_CFC: "0",
      },
    });
    try {
      expect(await agentEnvOf("claude-code", own.url, userHome)).toBe("0");
    } finally {
      await own.close();
      rmSync(userHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
