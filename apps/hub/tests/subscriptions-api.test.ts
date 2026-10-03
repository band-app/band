/**
 * Subscriptions API and the webhook and timer sources (plan step S.2),
 * through the real server: tRPC, `POST /api/hooks/:id`, the MCP endpoint,
 * with the coding agent running as the scripted ACP stub. Deliveries are
 * read from the prompts the stub received.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  runTurn,
  startAcpServer,
  stubRequests,
  TEST_TOKEN,
  trpc,
  WORKSPACE_ID,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

let servers: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function boot() {
  const server = await startAcpServer();
  servers.push(server);
  return server;
}

let seq = 0;
async function newChat(url: string): Promise<string> {
  const id = `sub-api-${Date.now()}-${seq++}`;
  await trpc(url, "chats.create", { workspaceId: WORKSPACE_ID, id });
  return id;
}

interface Created {
  id: string;
  chatId: string;
  webhook?: { path: string; token: string };
}

function prompts(home: string): string[] {
  return stubRequests(home, "session/prompt").map((r) =>
    JSON.stringify((r.params as { prompt?: unknown }).prompt),
  );
}

function updatePrompts(home: string, needle: string): string[] {
  return prompts(home).filter((p) => p.includes("Subscription update") && p.includes(needle));
}

describe("subscriptions api", () => {
  it("delivers a webhook to the chat and rejects a wrong token (S1)", async () => {
    const { url, home } = await boot();
    const chatId = await newChat(url);
    const created = await trpc<Created>(url, "subscriptions.create", {
      source: "webhook",
      chatId,
      workspaceId: WORKSPACE_ID,
      coalesceSeconds: 0,
    });
    const token = created.webhook?.token ?? "";
    expect(token).toMatch(/^bwh_/);
    const hook = `${url}/api/hooks/${created.id}`;

    const bad = await fetch(hook, {
      method: "POST",
      headers: { "X-Band-Webhook-Token": "wrong" },
      body: JSON.stringify({ summary: "should not arrive" }),
    });
    expect(bad.status).toBe(401);
    const none = await fetch(hook, { method: "POST", body: "x" });
    expect(none.status).toBe(401);
    const unknown = await fetch(`${url}/api/hooks/sub_missing`, {
      method: "POST",
      headers: { "X-Band-Webhook-Token": token },
      body: "x",
    });
    expect(unknown.status).toBe(404);

    const ok = await fetch(hook, {
      method: "POST",
      headers: { "X-Band-Webhook-Token": token },
      body: JSON.stringify({ summary: "deploy finished" }),
    });
    expect(ok.status).toBe(202);

    await waitFor(async () => updatePrompts(home, "deploy finished").length === 1, {
      label: "webhook delivery",
    });
    expect(updatePrompts(home, "should not arrive")).toHaveLength(0);

    // The same body again is a redelivery and is dropped. A second, distinct
    // body sent after it anchors the check: once it arrives, the redelivery
    // would have too.
    const again = await fetch(hook, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ summary: "deploy finished" }),
    });
    expect(again.status).toBe(202);
    const anchor = await fetch(hook, {
      method: "POST",
      headers: { "X-Band-Webhook-Token": token, "X-Delivery-Id": "d-1" },
      body: "plain text, no summary field",
    });
    expect(anchor.status).toBe(202);
    await waitFor(async () => updatePrompts(home, "plain text, no summary field").length === 1, {
      label: "second webhook delivery",
    });
    expect(updatePrompts(home, "deploy finished")).toHaveLength(1);

    // An explicit delivery id wins over the body hash.
    await fetch(hook, {
      method: "POST",
      headers: { "X-Band-Webhook-Token": token, "X-Delivery-Id": "d-1" },
      body: "a different body with the same delivery id",
    });
    await fetch(hook, {
      method: "POST",
      headers: { "X-Band-Webhook-Token": token },
      body: JSON.stringify({ summary: "last one" }),
    });
    await waitFor(async () => updatePrompts(home, "last one").length === 1, {
      label: "third webhook delivery",
    });
    expect(updatePrompts(home, "same delivery id")).toHaveLength(0);

    const events = await trpc<{ summary: string }[]>(
      url,
      "subscriptions.events",
      { id: created.id },
      "query",
    );
    expect(events.map((e) => e.summary).sort()).toEqual(
      ["deploy finished", "last one", "plain text, no summary field"].sort(),
    );

    // The listing never shows the secret.
    const listed = await trpc<Record<string, unknown>[]>(
      url,
      "subscriptions.list",
      { chatId },
      "query",
    );
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain("secretHash");

    // A removed subscription's hook is gone.
    await trpc(url, "subscriptions.remove", { id: created.id });
    const gone = await fetch(hook, {
      method: "POST",
      headers: { "X-Band-Webhook-Token": token },
      body: "x",
    });
    expect(gone.status).toBe(404);
  });

  it("fires cron timers and removes a one-off after it fired (S2)", async () => {
    const { url, home } = await boot();
    const chatId = await newChat(url);

    const cron = await trpc<Created>(url, "subscriptions.create", {
      source: "timer",
      chatId,
      cron: "*/2 * * * * *",
    });
    await waitFor(async () => updatePrompts(home, `timer:${cron.id}`).length >= 1, {
      label: "cron timer delivery",
      timeoutMs: 20_000,
    });
    await trpc(url, "subscriptions.remove", { id: cron.id });

    const oneOff = await trpc<Created>(url, "subscriptions.create", {
      source: "timer",
      chatId,
      at: Date.now() + 1500,
    });
    await waitFor(async () => updatePrompts(home, `timer:${oneOff.id}`).length === 1, {
      label: "one-off timer delivery",
      timeoutMs: 20_000,
    });
    await waitFor(
      async () =>
        (await trpc<Created[]>(url, "subscriptions.list", { chatId }, "query")).every(
          (s) => s.id !== oneOff.id,
        ),
      { label: "one-off timer removed" },
    );
    expect(updatePrompts(home, `timer:${oneOff.id}`)).toHaveLength(1);
  });

  it("rejects bad timers and unknown chats", async () => {
    const { url } = await boot();
    const chatId = await newChat(url);
    await expect(
      trpc(url, "subscriptions.create", { source: "timer", chatId, cron: "not a cron" }),
    ).rejects.toThrow(/400/);
    await expect(
      trpc(url, "subscriptions.create", { source: "timer", chatId, at: Date.now() - 1000 }),
    ).rejects.toThrow(/400/);
    await expect(
      trpc(url, "subscriptions.create", {
        source: "timer",
        chatId,
        at: Date.now() + 60_000,
        cron: "* * * * *",
      }),
    ).rejects.toThrow(/400/);
    await expect(trpc(url, "subscriptions.create", { source: "webhook" })).rejects.toThrow(/400/);
    await expect(
      trpc(url, "subscriptions.create", {
        source: "webhook",
        chatId: "no-such-chat",
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow(/404/);
  });

  it("refuses the subscription procedures without the server token", async () => {
    const { url } = await boot();
    const create = await fetch(`${url}/trpc/subscriptions.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "webhook", chatId: "x", workspaceId: WORKSPACE_ID }),
    });
    expect(create.status).toBe(401);
    const list = await fetch(`${url}/trpc/subscriptions.list`);
    expect(list.status).toBe(401);
  });

  it("defaults the chat from an agent's headers", async () => {
    const { url } = await boot();
    const chatId = await newChat(url);
    const res = await fetch(`${url}/trpc/subscriptions.create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `band_token=${TEST_TOKEN}`,
        "x-band-chat-id": chatId,
        "x-band-workspace-id": WORKSPACE_ID,
      },
      body: JSON.stringify({ source: "webhook" }),
    });
    const body = (await res.json()) as { result: { data: Created } };
    expect(res.status).toBe(200);
    expect(body.result.data.chatId).toBe(chatId);
  });

  it("gives an ACP agent its chat and workspace ids (S3)", async () => {
    const { url, home } = await boot();
    const chatId = await newChat(url);
    await runTurn(url, chatId, "hello");
    const [sent] = stubRequests(home, "session/prompt");
    expect(sent.env.BAND_CHAT_ID).toBe(chatId);
    expect(sent.env.BAND_WORKSPACE_ID).toBe(WORKSPACE_ID);
  });

  it("lists the subscription tools on the MCP endpoint (S4)", async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Cookie: `band_token=${TEST_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const text = await res.text();
    const data = text.includes("data:")
      ? (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5)
      : text;
    const names = (JSON.parse(data) as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name,
    );
    for (const tool of ["create", "list", "remove", "events"]) {
      expect(names).toContain(`band_subscriptions_${tool}`);
    }
  });
});
