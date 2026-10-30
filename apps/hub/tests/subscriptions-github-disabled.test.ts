/**
 * The GitHub subscription source with the GitHub plugin in `plugins.disabled`, through the real
 * server: a signed delivery to `POST /api/hooks/github` produces no event and answers 404, and
 * creating a subscription runs no `gh` call. The coding agent is the scripted ACP stub; GitHub is
 * the `gh` Express stub (`BAND_GH_BIN`).
 */

import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import {
  seedAcpHome,
  startAcpServer,
  stubRequests,
  TEST_TOKEN,
  trpc,
  WORKTREE_ID,
} from "./helpers/acp-chat";
import { seedSettings } from "./helpers/seed-state";
import type { ServerHandle } from "./helpers/server";

const SECRET = "test-github-webhook-secret";
const FULL = "acme/widgets";

let home: string;
let server: ServerHandle;
let stub: GhStub;

beforeAll(async () => {
  home = seedAcpHome("band-subs-github-disabled-");
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
    plugins: { disabled: ["github"] },
  });
  stub = await ghStub.start();
  server = await startAcpServer({
    home,
    env: { ...stub.env, BAND_GITHUB_WEBHOOK_SECRET: SECRET, BAND_PUBLIC_URL: "https://hub.test" },
  });
}, 60_000);

afterAll(async () => {
  await server?.close();
  await stub?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("github subscriptions with the plugin disabled", () => {
  it("answers a signed delivery with 404 and wakes nobody (S7)", async () => {
    await trpc(server.url, "chats.create", { worktreeId: WORKTREE_ID, id: "disabled-chat" });
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: FULL },
      sender: { login: "acme" },
      issue: { number: 7, pull_request: {} },
      comment: { body: "ignored", html_url: "https://github.com/c" },
    });
    const response = await fetch(`${server.url}/api/hooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "d-disabled",
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      },
      body,
    });
    expect(response.status).toBe(404);
    expect(stubRequests(home, "session/prompt")).toEqual([]);
  });

  it("registers no webhook for a new subscription (S7)", async () => {
    // The plugin cannot register one, so the subscription records a failure and waits for polling.
    await trpc(server.url, "subscriptions.create", {
      source: "github",
      repo: FULL,
      branch: "main",
      chatId: "disabled-chat",
      worktreeId: WORKTREE_ID,
    }).catch(() => undefined);
    expect(stub.requests.filter((r) => r.positional[1] === `repos/${FULL}/hooks`)).toEqual([]);
  });
});
