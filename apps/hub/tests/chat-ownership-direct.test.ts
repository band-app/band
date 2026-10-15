// Integration tests for an owned chat on the worker's direct listener:
// the desktop app's path, where the send and the event stream go to `127.0.0.1:<worker port>`
// and the hub only gets the replicated copy. A real hub and a real `band-worker` started with
// `--own-chats`, dialing the hub through a proxy the test can cut. The lease is two minutes, so a
// cut shorter than that leaves the worker running (what happens past the lease is an open
// decision, see the PR). The coding agent is the scripted ACP stub on the worker.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DirectAccess } from "@band-app/shared/direct-access";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentText, maxId, openStream, turnEnded } from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { type CuttableProxy, startCuttableProxy } from "./helpers/cuttable-proxy";
import { waitFor } from "./helpers/wait-for";

interface LogRow {
  id: number;
  session_id: string;
  kind: string;
  payload: string;
}

function readLog(file: string, chatId: string): LogRow[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, session_id, kind, payload FROM chat_events WHERE chat_id = ? ORDER BY id",
      )
      .all(chatId) as unknown as LogRow[];
  } finally {
    db.close();
  }
}

let w: World;
let owner: Worker;
let proxy: CuttableProxy;
let wt = "";
let access: DirectAccess;
const chatId = "direct-chat";

const hubLog = () => readLog(join(w.hubHome, ".band", "band.db"), chatId);
const workerLog = () => readLog(join(owner.state, "chats.db"), chatId);
const direct = () => `http://127.0.0.1:${access.port}`;
const bearer = () => ({ Authorization: `Bearer ${access.token}` });

/** Sends a message to the worker's direct port, as the desktop app does for an owned chat. */
async function sendDirect(text: string): Promise<{ ok: boolean; queued: boolean }> {
  const res = await fetch(`${direct()}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer() },
    body: JSON.stringify({ worktreeId: wt, text }),
  });
  if (!res.ok) throw new Error(`direct send: ${res.status} ${await res.text()}`);
  return (await res.json()) as { ok: boolean; queued: boolean };
}

/** Sends one message on the direct path and collects the direct stream until its turn ends. */
async function directTurn(text: string, after: number) {
  const stream = await openStream(direct(), chatId, {
    lastEventId: after,
    headers: bearer(),
    until: (e) => turnEnded(e) && e.eventId > after,
    timeoutMs: 60_000,
  });
  await sendDirect(text);
  return stream.events;
}

const hostStatus = async () =>
  (await w.q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
    (h) => h.id === owner.hostId,
  )?.status;

beforeAll(async () => {
  w = await startWorld({
    repos: [{ name: "proj" }],
    env: { BAND_WORKER_LEASE_MS: "120000" },
  });
  proxy = await startCuttableProxy(w.server.url);
  owner = await w.addWorker("owner", ["proj"], { ownChats: true, hubUrl: proxy.url });
  wt = await w.createWorktree(owner, "proj", "feat-direct");
  await w.m("chats.create", { worktreeId: wt, id: chatId, name: "Chat" });
  const issued = await w.m<DirectAccess | null>("worktree.directAccess", {
    worktreeId: wt,
    hostId: owner.hostId,
  });
  if (!issued) throw new Error("the worker offered no direct path");
  access = issued;
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  await w?.close();
});

describe("send and stream on the direct path (S1)", () => {
  it("gives a new chat on an owning worker to that worker at once", async () => {
    const { chat } = await w.q<{ chat: { ownerHostId?: string } | null }>("chats.get", { chatId });
    expect(chat?.ownerHostId).toBe(owner.hostId);
  });

  it("runs a message sent to the worker's port and streams the turn from there", async () => {
    const events = await directTurn("hello on loopback", 0);
    expect(agentText(events)).toContain("hello on loopback");
    expect(events.find((e) => e.type === "prompt")).toMatchObject({ text: "hello on loopback" });
    // The agent ran on the worker, which logged the turn itself.
    expect(workerLog().some((r) => r.kind === "turn-ended")).toBe(true);
  }, 90_000);

  it("leaves the hub with the same log, which a second client reads", async () => {
    await waitFor(
      () => {
        const hub = hubLog();
        return hub.length > 0 && JSON.stringify(hub) === JSON.stringify(workerLog())
          ? true
          : undefined;
      },
      { label: "the hub's copy", timeoutMs: 10_000 },
    );
    const replay = await openStream(w.server.url, chatId, {
      until: (e) => e.type === "history-meta",
      timeoutMs: 10_000,
    });
    expect((await replay.events).some((e) => e.type === "prompt")).toBe(true);
  }, 30_000);

  it("refuses the chat routes without a token and with a token for another worktree", async () => {
    const noToken = await fetch(`${direct()}/api/chats/${chatId}/events`);
    expect(noToken.status).toBe(401);
    const other = await w.createWorktree(owner, "proj", "feat-other");
    const otherAccess = await w.m<DirectAccess | null>("worktree.directAccess", {
      worktreeId: other,
      hostId: owner.hostId,
    });
    const wrongScope = await fetch(`${direct()}/api/chats/${chatId}/events`, {
      headers: { Authorization: `Bearer ${otherAccess?.token}` },
    });
    expect(wrongScope.status).toBe(403);
  }, 60_000);

  it("refuses a session id that a CLI would read as a flag, and a chat id it cannot decode", async () => {
    const before = workerLog().length;
    const badSession = await fetch(`${direct()}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer() },
      body: JSON.stringify({ text: "never runs", sessionId: "--dangerous" }),
    });
    expect(badSession.status).toBe(400);
    expect(await badSession.json()).toEqual({ error: "invalid session id" });
    const badId = await fetch(`${direct()}/api/chats/%E0%A4%A/events`, { headers: bearer() });
    expect(badId.status).toBe(400);
    expect(await badId.json()).toEqual({ error: "Bad chat id" });
    // Nothing ran: the worker logged no new row.
    expect(workerLog().length).toBe(before);
  });

  it("answers 404 for a chat the worker does not own, so the app uses the hub", async () => {
    const res = await fetch(`${direct()}/api/chats/not-owned-chat/events`, { headers: bearer() });
    expect(res.status).toBe(404);
  });
});

describe("a cut link (S3, within the lease)", () => {
  it("answers two local messages while the hub is unreachable, then the hub catches up", async () => {
    let after = Math.max(0, ...workerLog().map((r) => r.id));
    await proxy.cut();
    await waitFor(async () => ((await hostStatus()) !== "online" ? true : undefined), {
      label: "the hub sees the worker go",
      timeoutMs: 60_000,
    });

    const first = await directTurn("first while offline", after);
    expect(agentText(first)).toContain("first while offline");
    after = maxId(first);
    const second = await directTurn("second while offline", after);
    expect(agentText(second)).toContain("second while offline");

    const promptsOn = (rows: LogRow[]) =>
      rows
        .filter((r) => r.kind === "prompt")
        .map((r) => (JSON.parse(r.payload) as { text: string }).text);
    expect(promptsOn(hubLog())).not.toContain("first while offline");

    await proxy.restore();
    await waitFor(
      () => (JSON.stringify(hubLog()) === JSON.stringify(workerLog()) ? true : undefined),
      { label: "the hub catches up", timeoutMs: 60_000 },
    );
    const hub = hubLog();
    // Every row once, in order, none missing.
    expect(new Set(hub.map((r) => r.id)).size).toBe(hub.length);
    expect(hub.map((r) => r.id)).toEqual([...hub.map((r) => r.id)].sort((a, b) => a - b));
    expect(promptsOn(hub)).toEqual([
      "hello on loopback",
      "first while offline",
      "second while offline",
    ]);
  }, 180_000);
});
