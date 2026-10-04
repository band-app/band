/**
 * The GitHub subscription source (plan step S.3), through the real server:
 * signed `POST /api/hooks/github` deliveries, CI aggregation per commit and
 * webhook registration. The coding agent is the scripted ACP stub; GitHub
 * is the `gh` Express stub (`BAND_GH_BIN`), so no request leaves the machine.
 */

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type GhInvocation, type GhStub, ghStub } from "./fixtures/gh-stub";
import { startAcpServer, stubRequests, trpc, WORKSPACE_ID } from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const SECRET = "test-github-webhook-secret";
const REPO = { owner: "acme", name: "widgets" };
const FULL = "acme/widgets";

let servers: ServerHandle[] = [];
let stubs: GhStub[] = [];
afterEach(async () => {
  await Promise.allSettled(servers.map((s) => s.close()));
  await Promise.allSettled(stubs.map((s) => s.stop()));
  servers = [];
  stubs = [];
});

async function boot(env: Record<string, string> = {}) {
  const stub = await ghStub.start();
  stubs.push(stub);
  const server = await startAcpServer({
    env: { ...stub.env, BAND_GITHUB_WEBHOOK_SECRET: SECRET, ...env },
  });
  servers.push(server);
  return { ...server, stub };
}

let seq = 0;
async function newChat(url: string): Promise<string> {
  const id = `gh-sub-${Date.now()}-${seq++}`;
  await trpc(url, "chats.create", { workspaceId: WORKSPACE_ID, id });
  return id;
}

function updatePrompts(home: string, needle: string): string[] {
  return stubRequests(home, "session/prompt")
    .map((r) => JSON.stringify((r.params as { prompt?: unknown }).prompt))
    .filter((p) => p.includes("Subscription update") && p.includes(needle));
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function deliver(
  url: string,
  event: string,
  delivery: string,
  payload: unknown,
  signature?: string,
): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${url}/api/hooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature ?? sign(body),
    },
    body,
  });
}

// The repo owner, so the default sender allowlist lets these events through.
const sender = { login: "acme" };
const repository = { full_name: FULL };

function review(number: number, text: string) {
  return {
    action: "submitted",
    repository,
    sender,
    pull_request: { number, html_url: `https://github.com/${FULL}/pull/${number}` },
    review: { state: "changes_requested", body: text, html_url: "https://github.com/r" },
  };
}

function checkCompleted(sha: string, branch: string) {
  return {
    action: "completed",
    repository,
    sender,
    check_run: { head_sha: sha, check_suite: { head_branch: branch } },
  };
}

const hookCalls = (stub: GhStub): GhInvocation[] =>
  stub.requests.filter((r) => r.positional[1] === `repos/${FULL}/hooks`);

describe("github subscriptions", () => {
  it("delivers a signed review once and rejects a bad signature (S1)", async () => {
    const { url, home } = await boot();
    const chatId = await newChat(url);
    await trpc(url, "subscriptions.create", {
      source: "github",
      repo: FULL,
      pr: 7,
      chatId,
      workspaceId: WORKSPACE_ID,
      coalesceSeconds: 0,
    });

    const forged = await deliver(
      url,
      "pull_request_review",
      "d-forged",
      review(7, "forged review"),
      sign("{}", "wrong-secret"),
    );
    expect(forged.status).toBe(401);
    // Right secret, but the signature covers a different body.
    const tampered = await deliver(
      url,
      "pull_request_review",
      "d-tampered",
      review(7, "tampered review"),
      sign(JSON.stringify(review(7, "original review"))),
    );
    expect(tampered.status).toBe(401);
    const unsigned = await fetch(`${url}/api/hooks/github`, { method: "POST", body: "{}" });
    expect(unsigned.status).toBe(401);

    const ok = await deliver(url, "pull_request_review", "d-1", review(7, "please rename it"));
    expect(ok.status).toBe(202);
    await waitFor(async () => updatePrompts(home, "please rename it").length === 1, {
      label: "review delivery",
    });

    // The same delivery id again is ignored. A distinct comment sent after it
    // anchors the check: once that arrives, a repeat would have too.
    const again = await deliver(url, "pull_request_review", "d-1", review(7, "please rename it"));
    expect(again.status).toBe(202);
    const other = await deliver(url, "issue_comment", "d-2", {
      action: "created",
      repository,
      sender,
      issue: { number: 7, pull_request: {}, html_url: "https://github.com/i" },
      comment: { body: "anchor comment", html_url: "https://github.com/c" },
    });
    expect(other.status).toBe(202);
    await waitFor(async () => updatePrompts(home, "anchor comment").length === 1, {
      label: "anchor delivery",
    });

    expect(updatePrompts(home, "please rename it")).toHaveLength(1);
    expect(updatePrompts(home, "forged review")).toHaveLength(0);
  });

  it("delivers CI once, after every check completed, naming the failed check (S2)", async () => {
    const { url, home, stub } = await boot();
    const chatId = await newChat(url);
    const sha = "abc1234def5678abc1234def5678abc1234def56";
    await trpc(url, "subscriptions.create", {
      source: "github",
      repo: FULL,
      branch: "feature/x",
      chatId,
      workspaceId: WORKSPACE_ID,
      coalesceSeconds: 0,
    });

    let secondDone = false;
    stub.setCheckRuns(REPO, sha, () => [
      { name: "build", status: "completed", conclusion: "success" },
      secondDone
        ? { name: "e2e-tests", status: "completed", conclusion: "failure" }
        : { name: "e2e-tests", status: "in_progress", conclusion: null },
    ]);
    const fetches = () => stub.requests.filter((r) => r.positional[1]?.includes("/check-runs"));

    const first = await deliver(url, "check_run", "c-1", checkCompleted(sha, "feature/x"));
    expect(first.status).toBe(202);
    await waitFor(async () => fetches().length === 1, { label: "first checks fetch" });

    secondDone = true;
    const second = await deliver(url, "check_run", "c-2", checkCompleted(sha, "feature/x"));
    expect(second.status).toBe(202);
    await waitFor(async () => updatePrompts(home, "e2e-tests").length === 1, {
      label: "ci delivery",
    });

    // Nothing went out for the first completion, so this is the only message.
    const prompts = updatePrompts(home, "Subscription update");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("1 of 2 checks failed");
    expect(prompts[0]).not.toContain("build,");
  });

  it("sees checks past the first page of 100 (S2)", async () => {
    const { url, home, stub } = await boot();
    const chatId = await newChat(url);
    const sha = "1111111def5678abc1234def5678abc1234def56";
    await trpc(url, "subscriptions.create", {
      source: "github",
      repo: FULL,
      branch: "big",
      chatId,
      workspaceId: WORKSPACE_ID,
      coalesceSeconds: 0,
    });
    // 100 passing checks fill page 1. The pending one is only on page 2, so a
    // single-page fetch would report success too early.
    let lastDone = false;
    stub.setCheckRuns(REPO, sha, () => [
      ...Array.from({ length: 100 }, (_, i) => ({
        name: `job-${i}`,
        status: "completed" as const,
        conclusion: "success",
      })),
      lastDone
        ? { name: "slow-job", status: "completed" as const, conclusion: "failure" }
        : { name: "slow-job", status: "in_progress" as const, conclusion: null },
    ]);
    const fetches = () => stub.requests.filter((r) => r.positional[1]?.includes("/check-runs"));

    await deliver(url, "check_run", "p-1", checkCompleted(sha, "big"));
    await waitFor(async () => fetches().length === 2, { label: "both pages fetched" });
    lastDone = true;
    await deliver(url, "check_run", "p-2", checkCompleted(sha, "big"));
    await waitFor(async () => updatePrompts(home, "slow-job").length === 1, {
      label: "ci delivery",
    });
    const prompts = updatePrompts(home, "Subscription update");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("1 of 101 checks failed");
  });

  it("reports a cancelled run as its own outcome (S2)", async () => {
    const { url, home, stub } = await boot();
    const chatId = await newChat(url);
    const sha = "2222222def5678abc1234def5678abc1234def56";
    await trpc(url, "subscriptions.create", {
      source: "github",
      repo: FULL,
      branch: "cancel",
      chatId,
      workspaceId: WORKSPACE_ID,
      coalesceSeconds: 0,
    });
    stub.setCheckRuns(REPO, sha, [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "deploy-preview", status: "completed", conclusion: "cancelled" },
    ]);
    await deliver(url, "check_run", "x-1", checkCompleted(sha, "cancel"));
    await waitFor(async () => updatePrompts(home, "deploy-preview").length === 1, {
      label: "cancelled delivery",
    });
    const [prompt] = updatePrompts(home, "Subscription update");
    expect(prompt).toContain("1 of 2 checks were cancelled");
    expect(prompt).not.toContain("failed");
  });

  it("registers the repo webhook once when a public URL is configured (S3)", async () => {
    const { url, stub } = await boot({ BAND_PUBLIC_URL: "https://hub.example.test/ignored?x=1" });
    stub.setHookCreate(REPO);
    const chatId = await newChat(url);
    const base = { source: "github", repo: FULL, chatId, workspaceId: WORKSPACE_ID };

    const first = await trpc<{ webhook?: { status: string } }>(url, "subscriptions.create", {
      ...base,
      pr: 1,
    });
    expect(first.webhook?.status).toBe("registered");
    const second = await trpc<{ webhook?: { status: string } }>(url, "subscriptions.create", {
      ...base,
      branch: "main",
    });
    expect(second.webhook?.status).toBe("registered");

    const calls = hookCalls(stub);
    expect(calls).toHaveLength(1);
    // The body arrives on stdin, so the secret is nowhere in argv.
    expect(JSON.stringify(calls[0].args)).not.toContain(SECRET);
    const body = calls[0].input as {
      config: { url: string; secret: string; content_type: string };
      events: string[];
    };
    expect(body.config.url).toBe("https://hub.example.test/api/hooks/github");
    expect(body.config.secret).toBe(SECRET);
    expect(body.config.content_type).toBe("json");
    expect(body.events).toEqual(
      expect.arrayContaining([
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "issue_comment",
        "check_suite",
        "check_run",
        "workflow_run",
        "push",
      ]),
    );
  });

  it("does not call the hooks API without a public URL (S3)", async () => {
    const { url, stub } = await boot();
    stub.setHookCreate(REPO);
    const chatId = await newChat(url);
    const created = await trpc<{ webhook?: { status: string } }>(url, "subscriptions.create", {
      source: "github",
      repo: FULL,
      pr: 1,
      chatId,
      workspaceId: WORKSPACE_ID,
    });
    expect(created.webhook?.status).toBe("waiting-for-url");
    expect(hookCalls(stub)).toHaveLength(0);
  });

  it("records an existing hook as registered and a failure without the secret", async () => {
    const existing = await boot({ BAND_PUBLIC_URL: "https://hub.example.test" });
    existing.stub.setHookCreate(REPO, {
      stderr: "Validation Failed: Hook already exists on this repository",
    });
    const chatA = await newChat(existing.url);
    const ok = await trpc<{ webhook?: { status: string } }>(existing.url, "subscriptions.create", {
      source: "github",
      repo: FULL,
      pr: 1,
      chatId: chatA,
      workspaceId: WORKSPACE_ID,
    });
    expect(ok.webhook?.status).toBe("registered");

    const broken = await boot({ BAND_PUBLIC_URL: "https://hub.example.test" });
    broken.stub.setHookCreate(REPO, { stderr: "HTTP 404: Not Found" });
    const chatB = await newChat(broken.url);
    const failed = await trpc<{ webhook?: { status: string; error?: string } }>(
      broken.url,
      "subscriptions.create",
      { source: "github", repo: FULL, pr: 1, chatId: chatB, workspaceId: WORKSPACE_ID },
    );
    expect(failed.webhook?.status).toBe("failed");
    expect(failed.webhook?.error).toContain("404");
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });
});
