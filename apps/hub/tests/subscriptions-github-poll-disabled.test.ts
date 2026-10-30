/**
 * The GitHub polling fallback with the GitHub plugin in `plugins.disabled`: `poll()` runs no
 * `gh`. It calls `SubscriptionPollService.poll` directly for the reason given in
 * `subscriptions-github-poll.test.ts` (the branch-status poller's CI tick is 30 s apart), against
 * a real SQLite database under a temp `BAND_HOME` and the `gh` Express stub. The plugin host reads
 * `plugins.disabled` once per process, so this case has a file of its own.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import { chatService } from "../src/server/services/chat-service";
import { subscriptionPollService } from "../src/server/services/subscription-poll-service";
import { subscriptionService } from "../src/server/services/subscription-service";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import { TEST_TOKEN } from "./helpers/acp-chat";
import { assertTempBandHome } from "./helpers/band-home";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome } from "./helpers/server";

const REPO = "testrepo";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const ENV_KEYS = ["BAND_HOME", "BAND_GH_BIN", "BAND_GH_STUB_URL", "GH_TOKEN", "GITHUB_TOKEN"];
const originalEnv: Record<string, string | undefined> = {};

let home: string;
let stub: GhStub;

beforeAll(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  home = realpathSync(createTmpHome("band-subscriptions-poll-disabled-"));
  process.env.BAND_HOME = join(home, ".band");
  assertTempBandHome();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  seedState(home, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
    plugins: { disabled: ["github"] },
  });
  stub = await ghStub.start();
  Object.assign(process.env, stub.env);
});

afterAll(async () => {
  assertTempBandHome();
  await stub.stop();
  closeDb();
  for (const key of ENV_KEYS) {
    if (key === "BAND_HOME") continue;
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("github polling with the plugin disabled", () => {
  it("S7: a poll makes no gh call for a stored GitHub subscription", async () => {
    const chat = chatService.create(WORKTREE);
    subscriptionService.createGithubPr({
      chatId: chat.id,
      worktreeId: WORKTREE,
      coalesceSeconds: 0,
      repo: "acme/widgets",
      number: 7,
    });
    await subscriptionPollService.poll();
    expect(stub.requests).toEqual([]);
  });
});
