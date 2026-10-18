// A worker that owns its chats (`--own-chats`) starts the agent itself, from a launch reply the hub
// sends. The reply carries the login's variables, and the worker must apply them to the child
// without writing them into its `chats.db`, which outlives a rotated or deleted secret.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";

const SETUP_TOKEN = "sk-ant-oat01-OWNCHATS-SETUPTOKEN-plaintext-8888";

let w: World;
let owner: Worker;

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }] });
  owner = await w.addWorker("owner", ["proj"], {
    ownChats: true,
    env: { BAND_TEST_ACP_LOG_ENV: "CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY" },
  });
}, 120_000);

afterAll(async () => {
  await w?.close();
});

describe("agent logins on a worker that owns its chats", () => {
  it("starts the agent with the login and keeps the secret out of chats.db", async () => {
    const { login } = await w.m<{ login: { id: string } }>("agentLogins.create", {
      agentType: "claude-code",
      kind: "setup-token",
      label: "Owner token",
      secret: SETUP_TOKEN,
    });
    await w.m("agentLogins.setDefault", { agentType: "claude-code", loginId: login.id });

    const worktreeId = await w.createWorktree(owner, "proj", "feat-login");
    await w.turn(worktreeId, "owned-login-chat", "hello");

    const started = readFileSync(owner.stubLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (l) => JSON.parse(l) as { method: string; env: { NAMED: Record<string, string | null> } },
      )
      .find((r) => r.method === "session/new");
    // The helper gives every worker an ANTHROPIC_API_KEY, which a setup-token login removes.
    expect(started?.env.NAMED).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: SETUP_TOKEN,
      ANTHROPIC_API_KEY: null,
    });

    // The worker ran the chat itself, so its store exists.
    expect(existsSync(join(owner.state, "chats.db"))).toBe(true);
    for (const file of ["chats.db", "chats.db-wal"]) {
      const path = join(owner.state, file);
      if (existsSync(path)) expect(readFileSync(path).includes(SETUP_TOKEN)).toBe(false);
    }
    expect(owner.output()).not.toContain(SETUP_TOKEN);
  }, 90_000);
});
