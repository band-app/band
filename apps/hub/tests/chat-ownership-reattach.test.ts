// Integration tests for step 1.3 of the roles-and-updates plan: a worker restart ends no owned chat.
// A real hub and a real `band-worker --own-chats`, killed (SIGTERM and SIGKILL) and started again
// on the same state directory, with the scripted ACP stub as the agent. The agent daemon keeps the
// stub running while the worker is down. The restarted worker rebuilds the chat's client from
// `chats.db`, reattaches to the daemon, and the turn that was running finishes.
//
// What each case reads:
// - the worker's `chats.db` and the hub's `band.db`: the rows of the chat, for "exactly once" and
//   for the replicated copy;
// - the worker's direct listener: the event stream the desktop app reads, replayed from id 0;
// - the stub's request log: which requests the agent received, and from which process.
//
// S6 cannot be provoked by killing the worker at the right instant, so it edits the stored state
// the way a kill between the write to the daemon and the daemon's read would have left it (the
// prompt's end lies beyond the bytes the daemon wrote).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { DirectAccess } from "@band-app/shared/direct-access";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { type CuttableProxy, startCuttableProxy } from "./helpers/cuttable-proxy";
import { waitFor } from "./helpers/wait-for";

const CHUNKS = 200;
const chunk = (i: number) => `c${String(i).padStart(3, "0")}`;
const ALL_CHUNKS = Array.from({ length: CHUNKS }, (_, i) => chunk(i));

const SCENARIO = {
  turns: [
    {
      // About eight seconds, so a restart of the worker (a few seconds) lands inside the turn.
      match: "^stream",
      steps: ALL_CHUNKS.flatMap((text) => [{ say: text }, { sleep: 40 }]),
    },
    {
      match: "^ask",
      steps: [
        {
          permission: {
            toolCall: { toolCallId: "run-1", title: "Run tests", kind: "execute" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
          after: { allow: [{ say: "Allowed and ran." }] },
        },
      ],
    },
    { match: "^hold", steps: [{ sleep: 120_000 }] },
  ],
};

/** Opens a worker's database next to the worker, which may be recovering its WAL after a kill. */
function openDb(file: string, readOnly = true): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly });
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

let w: World;
let proxy: CuttableProxy;
let scenario = "";
let wt = "";

interface Row {
  id: number;
  kind: string;
  payload: string;
}

function readRows(file: string, chatId: string): Row[] {
  const db = openDb(file);
  try {
    return db
      .prepare("SELECT id, kind, payload FROM chat_events WHERE chat_id = ? ORDER BY id")
      .all(chatId) as unknown as Row[];
  } finally {
    db.close();
  }
}

const workerRows = (worker: Worker, chatId: string) =>
  readRows(join(worker.state, "chats.db"), chatId);
const hubRows = (chatId: string) => readRows(join(w.hubHome, ".band", "band.db"), chatId);

/** The text of every agent message chunk the stub scripted (c000, c001, ...), in log order. */
function chunkTexts(rows: Row[]): string[] {
  const texts: string[] = [];
  for (const row of rows) {
    if (row.kind !== "update") continue;
    const body = JSON.parse(row.payload) as {
      update?: { sessionUpdate?: string; content?: { text?: string } };
    };
    const text = body.update?.content?.text;
    if (body.update?.sessionUpdate === "agent_message_chunk" && text && /^c\d{3}$/.test(text)) {
      texts.push(text);
    }
  }
  return texts;
}

function turnEnds(rows: Row[]): Array<{ error?: string; stopReason?: string }> {
  return rows
    .filter((r) => r.kind === "turn-ended")
    .map((r) => JSON.parse(r.payload) as { error?: string; stopReason?: string });
}

function wireState(worker: Worker, chatId: string): Record<string, unknown> | null {
  const db = openDb(join(worker.state, "chats.db"));
  try {
    const row = db.prepare("SELECT state FROM chat_wire_state WHERE chat_id = ?").get(chatId) as
      | { state: string }
      | undefined;
    return row ? (JSON.parse(row.state) as Record<string, unknown>) : null;
  } finally {
    db.close();
  }
}

function queued(worker: Worker, chatId: string): string[] {
  const db = openDb(join(worker.state, "chats.db"));
  try {
    return (
      db
        .prepare("SELECT payload FROM queued_messages WHERE chat_id = ? ORDER BY seq")
        .all(chatId) as Array<{ payload: string }>
    ).map((r) => (JSON.parse(r.payload) as { text: string }).text);
  } finally {
    db.close();
  }
}

async function send(chatId: string, text: string): Promise<void> {
  const res = await fetch(`${w.server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId: wt, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
}

/** The worker's loopback listener, as the desktop app reaches it. Asked again after each restart. */
async function direct(worker: Worker) {
  const access = await w.m<DirectAccess | null>("worktree.directAccess", {
    worktreeId: wt,
    hostId: worker.hostId,
  });
  if (!access) throw new Error("the worker offered no direct path");
  return {
    url: `http://127.0.0.1:${access.port}`,
    headers: { Authorization: `Bearer ${access.token}` },
  };
}

/** The chat's whole stream from id 0 on the worker's listener, until `ends` turns have ended. */
async function streamTurns(worker: Worker, chatId: string, ends = 1) {
  const { url, headers } = await direct(worker);
  let seen = 0;
  const stream = await openStream(url, chatId, {
    lastEventId: 0,
    headers,
    until: (e) => turnEnded(e) && ++seen >= ends,
    timeoutMs: 90_000,
  });
  return stream.events;
}

/**
 * The runtime emits an event to the stream before the transaction that logs it commits, so a
 * reader that saw the event on the stream waits for the row.
 */
async function loggedTurnEnds(worker: Worker, chatId: string, count: number) {
  await waitFor(() => (turnEnds(workerRows(worker, chatId)).length >= count ? true : undefined), {
    label: `${count} turn end(s) in the worker's log`,
    timeoutMs: 30_000,
  });
  return turnEnds(workerRows(worker, chatId));
}

/** Waits until the hub's copy of the chat holds the same rows as the worker's. */
async function hubCatchesUp(worker: Worker, chatId: string): Promise<void> {
  await waitFor(
    () => {
      const mine = workerRows(worker, chatId).map((r) => r.id);
      const theirs = hubRows(chatId).map((r) => r.id);
      return mine.length > 0 && JSON.stringify(mine) === JSON.stringify(theirs) ? true : undefined;
    },
    { label: "the hub's copy to catch up", timeoutMs: 60_000 },
  );
}

/** The bytes of stub chunks arrive once and in order, however the turn was split by the restart. */
function expectWholeStream(texts: string[]): void {
  expect(texts).toEqual(ALL_CHUNKS);
}

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }], env: { BAND_WORKER_LEASE_MS: "120000" } });
  proxy = await startCuttableProxy(w.server.url);
  const dir = w.tmp("band-reattach-scenario-");
  mkdirSync(dir, { recursive: true });
  scenario = join(dir, "scenario.json");
  writeFileSync(scenario, JSON.stringify(SCENARIO));
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  await w?.close();
});

async function startOwner(name: string, extra: Record<string, string> = {}, viaProxy = false) {
  const worker = await w.addWorker(name, ["proj"], {
    ownChats: true,
    ...(viaProxy ? { hubUrl: proxy.url } : {}),
    env: { BAND_TEST_ACP_SCENARIO: scenario, ...extra },
  });
  wt = await w.createWorktree(worker, "proj", `feat-${name}`);
  return worker;
}

describe("a turn that runs while the worker restarts (S1)", () => {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    it(`finishes after ${signal}, every update once, locally and on the hub`, async () => {
      let worker = await startOwner(`s1-${signal.toLowerCase()}`);
      const chatId = `s1-${signal}`;
      await send(chatId, "stream through the restart");
      await waitFor(
        () => (chunkTexts(workerRows(worker, chatId)).length >= 15 ? true : undefined),
        {
          label: "part of the reply to be logged",
          timeoutMs: 60_000,
        },
      );
      const pidBefore = w.stubRequests(worker, "session/prompt")[0] as { pid?: number } | undefined;
      await w.killWorker(worker, signal, { waitForLease: false });
      worker = await w.restartWorker(worker);

      const events = await streamTurns(worker, chatId);
      const streamed = events.flatMap((e) =>
        e.type === "update" &&
        e.update.sessionUpdate === "agent_message_chunk" &&
        e.update.content.type === "text" &&
        /^c\d{3}$/.test(e.update.content.text)
          ? [e.update.content.text]
          : [],
      );
      expectWholeStream(streamed);

      const ends = await loggedTurnEnds(worker, chatId, 1);
      expectWholeStream(chunkTexts(workerRows(worker, chatId)));
      expect(ends).toHaveLength(1);
      expect(ends[0]?.error, "the turn was not closed as interrupted").toBeUndefined();
      expect(ends[0]?.stopReason).toBe("end_turn");
      // The same agent process answered the whole turn: it was never restarted.
      const prompts = w.stubRequests(worker, "session/prompt") as Array<{ pid?: number }>;
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.pid).toBe(pidBefore?.pid);

      await hubCatchesUp(worker, chatId);
      expectWholeStream(chunkTexts(hubRows(chatId)));
      expect(turnEnds(hubRows(chatId))).toHaveLength(1);
      // Nothing is left of the turn in the stored state.
      expect(wireState(worker, chatId)?.turn).toBeNull();
    }, 180_000);
  }
});

describe("a permission request waits across the restart (S2)", () => {
  it("is still shown, and the answer reaches the agent under its own id", async () => {
    let worker = await startOwner("s2");
    const chatId = "s2-chat";
    await send(chatId, "ask to run the tests");
    await waitFor(
      () => {
        const open = wireState(worker, chatId)?.openAgentRequests as
          | Array<{ requestId?: string }>
          | undefined;
        return open?.some((r) => r.requestId) ? true : undefined;
      },
      { label: "the permission request to be stored", timeoutMs: 60_000 },
    );
    await w.killWorker(worker, "SIGKILL", { waitForLease: false });
    worker = await w.restartWorker(worker);

    let requestId = "";
    const { url, headers } = await direct(worker);
    const stream = await openStream(url, chatId, {
      lastEventId: 0,
      headers,
      onEvent: (e) => {
        if (e.type === "permission") requestId = e.requestId;
      },
      until: turnEnded,
      timeoutMs: 90_000,
    });
    await waitFor(() => (requestId ? true : undefined), { label: "the permission request" });
    // The hub learns the open request from the rebuilt chat.
    await waitFor(
      async () => {
        const data = await w.q<{ agent?: { status: string } } | null>("statuses.get", {
          worktreeId: wt,
        });
        return data?.agent?.status === "question" ? true : undefined;
      },
      { label: "the hub to show the question", timeoutMs: 30_000 },
    );
    await w.m("chat.answer", { chatId, requestId, optionId: "allow" });
    const events = await stream.events;
    const text = events
      .flatMap((e) =>
        e.type === "update" &&
        e.update.sessionUpdate === "agent_message_chunk" &&
        e.update.content.type === "text"
          ? [e.update.content.text]
          : [],
      )
      .join("");
    // The agent only goes on when the answer carries the id it asked under.
    expect(text).toContain("Allowed and ran.");
    const ends = await loggedTurnEnds(worker, chatId, 1);
    const rows = workerRows(worker, chatId);
    expect(rows.filter((r) => r.kind === "permission")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "request-resolved")).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.error).toBeUndefined();
  }, 180_000);
});

describe("a message queued behind a running turn (S3)", () => {
  it("runs after the turn that finishes across the restart", async () => {
    let worker = await startOwner("s3");
    const chatId = "s3-chat";
    await send(chatId, "stream first");
    await waitFor(() => (chunkTexts(workerRows(worker, chatId)).length >= 10 ? true : undefined), {
      label: "part of the first reply",
      timeoutMs: 60_000,
    });
    await send(chatId, "second message");
    await waitFor(() => (queued(worker, chatId).length === 1 ? true : undefined), {
      label: "the second message to be queued",
      timeoutMs: 30_000,
    });
    await w.killWorker(worker, "SIGKILL", { waitForLease: false });
    worker = await w.restartWorker(worker);

    const events = await streamTurns(worker, chatId, 2);
    const prompts = events.flatMap((e) => (e.type === "prompt" ? [e.text] : []));
    expect(prompts).toEqual(["stream first", "second message"]);
    const ends = await loggedTurnEnds(worker, chatId, 2);
    expectWholeStream(chunkTexts(workerRows(worker, chatId)));
    expect(ends.map((t) => t.error)).toEqual([undefined, undefined]);
    expect(queued(worker, chatId)).toEqual([]);
    await hubCatchesUp(worker, chatId);
  }, 180_000);
});

describe("the hub is unreachable while the worker restarts (S4)", () => {
  it("rebuilds and finishes the turn, and replication catches up when the hub returns", async () => {
    let worker = await startOwner("s4", {}, true);
    const chatId = "s4-chat";
    await send(chatId, "stream without the hub");
    await waitFor(() => (chunkTexts(workerRows(worker, chatId)).length >= 15 ? true : undefined), {
      label: "part of the reply",
      timeoutMs: 60_000,
    });
    await w.killWorker(worker, "SIGKILL", { waitForLease: false });
    await proxy.cut();
    const restarted = w.restartWorker(worker);
    restarted.catch(() => undefined);

    // The worker finishes the turn on its own while the hub cannot be reached.
    await waitFor(() => (turnEnds(workerRows(worker, chatId)).length > 0 ? true : undefined), {
      label: "the turn to end with the hub away",
      timeoutMs: 60_000,
    }).catch((err: Error) => {
      const kinds = workerRows(worker, chatId).map((r) => r.kind);
      throw new Error(
        `${err.message}\nrows: ${kinds.slice(-8).join(",")} (${kinds.length})\nstate: ${JSON.stringify(wireState(worker, chatId))}`,
      );
    });
    expectWholeStream(chunkTexts(workerRows(worker, chatId)));
    expect(turnEnds(workerRows(worker, chatId))[0]?.error).toBeUndefined();
    expect(hubRows(chatId).length).toBeLessThan(workerRows(worker, chatId).length);

    await proxy.restore();
    worker = await restarted;
    await hubCatchesUp(worker, chatId);
    expectWholeStream(chunkTexts(hubRows(chatId)));
    expect(turnEnds(hubRows(chatId))).toHaveLength(1);
  }, 240_000);
});

describe("the launch changed while the worker was down (S5)", () => {
  it("keeps the agent until the turn ends, then restarts it for the next prompt", async () => {
    // The adapter file is part of the launch. A wrapper in a temp dir stands in for it, so a test
    // can change the file without touching the stub other tests use.
    const dir = w.tmp("band-reattach-adapter-");
    mkdirSync(dir, { recursive: true });
    const adapter = join(dir, "adapter.mjs");
    writeFileSync(adapter, `import ${JSON.stringify(pathToFileURL(STUB_AGENT_PATH).href)};\n`);
    let worker = await startOwner("s5", { BAND_TEST_ACP_AGENT: adapter });
    const chatId = "s5-chat";
    await send(chatId, "stream across a changed launch");
    await waitFor(() => (chunkTexts(workerRows(worker, chatId)).length >= 15 ? true : undefined), {
      label: "part of the reply",
      timeoutMs: 60_000,
    });
    const first = (w.stubRequests(worker, "session/prompt")[0] as { pid: number }).pid;
    await w.killWorker(worker, "SIGKILL", { waitForLease: false });
    appendFileSync(adapter, "// the adapter changed while the worker was down\n");
    worker = await w.restartWorker(worker);

    const events = await streamTurns(worker, chatId);
    expect(events.some(turnEnded)).toBe(true);
    expectWholeStream(chunkTexts(workerRows(worker, chatId)));
    // The turn ran to its end on the agent that started it.
    expect(
      (w.stubRequests(worker, "session/prompt") as Array<{ pid: number }>).map((r) => r.pid),
    ).toEqual([first]);
    // At the clean point the old agent is stopped...
    await waitFor(
      () => {
        try {
          process.kill(first, 0);
          return undefined;
        } catch {
          return true;
        }
      },
      { label: "the old agent to stop", timeoutMs: 30_000 },
    ).catch((err) => {
      throw new Error(`${err.message}\n${worker.output()}`);
    });
    // ...and the next prompt runs on a new one.
    await send(chatId, "after the change");
    await waitFor(
      () => (w.stubRequests(worker, "session/prompt").length === 2 ? true : undefined),
      {
        label: "the next prompt to reach an agent",
        timeoutMs: 60_000,
      },
    );
    const second = (w.stubRequests(worker, "session/prompt")[1] as { pid: number }).pid;
    expect(second).not.toBe(first);
  }, 240_000);
});

describe("a prompt the daemon never received (S6)", () => {
  it("is recorded as failed, the message stays queued and the agent gets nothing half written", async () => {
    let worker = await startOwner("s6");
    const chatId = "s6-chat";
    await send(chatId, "hold this message");
    await waitFor(
      () => {
        const open = wireState(worker, chatId)?.openClientRequests as
          | Array<{ method: string; stdinEnd?: number }>
          | undefined;
        return open?.some((r) => r.method === "session/prompt" && r.stdinEnd) ? true : undefined;
      },
      { label: "the prompt to be stored as open", timeoutMs: 60_000 },
    );
    await w.killWorker(worker, "SIGKILL", { waitForLease: false });

    // As a kill after the worker stored the request and before the daemon read it leaves it: the
    // prompt's end lies beyond the bytes the daemon wrote.
    const db = openDb(join(worker.state, "chats.db"), false);
    try {
      const row = db.prepare("SELECT state FROM chat_wire_state WHERE chat_id = ?").get(chatId) as {
        state: string;
      };
      const state = JSON.parse(row.state) as {
        openClientRequests: Array<{ method: string; stdinEnd?: number }>;
      };
      for (const r of state.openClientRequests) {
        if (r.method === "session/prompt") r.stdinEnd = 10_000_000;
      }
      db.prepare("UPDATE chat_wire_state SET state = ? WHERE chat_id = ?").run(
        JSON.stringify(state),
        chatId,
      );
    } finally {
      db.close();
    }
    const promptsBefore = w.stubRequests(worker, "session/prompt").length;
    worker = await w.restartWorker(worker);

    await waitFor(() => (turnEnds(workerRows(worker, chatId)).length > 0 ? true : undefined), {
      label: "the turn to be closed",
      timeoutMs: 60_000,
    });
    const ended = turnEnds(workerRows(worker, chatId));
    expect(ended).toHaveLength(1);
    expect(ended[0]?.error).toMatch(/before the agent received/);
    // The message is back at the head of the queue and nothing ran it again.
    expect(queued(worker, chatId)).toEqual(["hold this message"]);
    await new Promise((r) => setTimeout(r, 1500));
    expect(queued(worker, chatId)).toEqual(["hold this message"]);
    expect(w.stubRequests(worker, "session/prompt")).toHaveLength(promptsBefore);
    // The rebuilt client talks to the agent on ids above every earlier one, whole lines only.
    const prompt = wireState(worker, chatId);
    expect(prompt?.promptRequestId).toBeNull();
  }, 180_000);
});
