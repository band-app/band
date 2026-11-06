// Integration test for the Artifact tool default. Claude Code turns Artifact off for the Agent SDK
// entrypoint the ACP adapter uses unless CLAUDE_CODE_ARTIFACT is truthy, so Band sets it to 1 for
// Claude Code chats and leaves a value the machine already has. A real hub runs the scripted ACP
// stub, which records the variable it finds in its environment.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAcpServer, stubRequests, TEST_TOKEN, trpc } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle } from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { waitFor } from "./helpers/wait-for";

const ALPHA = testWorktreeId("alpha", "main");

interface Booted {
  home: string;
  server: ServerHandle;
}

async function boot(extraEnv: Record<string, string>): Promise<Booted> {
  const home = createTmpHome("band-agent-artifact-");
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
  const server = await startAcpServer({
    home,
    env: { BAND_SERVE_UI: "false", BAND_TEST_ACP_LOG_ENV: "CLAUDE_CODE_ARTIFACT", ...extraEnv },
  });
  return { home, server };
}

async function artifactEnvOf(b: Booted, chatId: string, agent: string) {
  await trpc(b.server.url, "chats.create", { worktreeId: ALPHA, id: chatId, agent });
  const res = await fetch(`${b.server.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId: ALPHA, text: "hello" }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  const request = await waitFor(
    () => stubRequests(b.home, "session/new").find((r) => r.env.BAND_CHAT_ID === chatId),
    { label: `agent of ${chatId} started` },
  );
  return request.env.NAMED.CLAUDE_CODE_ARTIFACT;
}

async function close(b: Booted) {
  await b.server.close();
  rmSync(b.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

describe("Artifact tool default", () => {
  let plain: Booted;
  let optedOut: Booted;

  beforeAll(async () => {
    plain = await boot({});
    optedOut = await boot({ CLAUDE_CODE_ARTIFACT: "0" });
  });

  afterAll(async () => {
    await Promise.all([close(plain), close(optedOut)]);
  });

  it("turns Artifact on for a Claude Code chat", async () => {
    expect(await artifactEnvOf(plain, "chat-claude", "claude-code")).toBe("1");
  });

  it("keeps a CLAUDE_CODE_ARTIFACT value the machine already has", async () => {
    expect(await artifactEnvOf(optedOut, "chat-optout", "claude-code")).toBe("0");
  });

  it("does not set it for a Codex chat", async () => {
    expect(await artifactEnvOf(plain, "chat-codex", "codex")).toBeNull();
  });
});
