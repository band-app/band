// Integration tests for the client state an owning worker keeps in `chats.db` (step 1.2 of the
// roles-and-updates plan). A real hub and a real `band-worker --own-chats`, killed with SIGKILL, and
// the scripted ACP stub as the agent. Nothing reads the state back yet, so the tests read the
// database the worker left, and the agent daemon's ring for what it still holds.
//
// The stored stdout offset is the byte position after the last line whose events are committed. The
// agent daemon releases output only up to a committed offset, so after a kill its ring starts at or
// before the stored offset and holds every line after it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentHolder } from "@band-app/host-local/agents/daemon/holder";
import { agentRunDir } from "@band-app/host-local/agents/daemon/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { waitFor } from "./helpers/wait-for";

const REATTACH_MS = 2000;

const chunk = (i: number) => `c${String(i).padStart(3, "0")}`;
const SCENARIO = {
  turns: [
    {
      match: "^stream",
      steps: Array.from({ length: 120 }, (_, i) => [{ say: chunk(i) }, { sleep: 8 }]).flat(),
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
  ],
};

let w: World;
let scenario = "";

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }], env: { BAND_WORKER_LEASE_MS: "120000" } });
  const dir = w.tmp("band-durable-scenario-");
  mkdirSync(dir, { recursive: true });
  scenario = join(dir, "scenario.json");
  writeFileSync(scenario, JSON.stringify(SCENARIO));
}, 120_000);

afterAll(async () => {
  await w?.close();
});

interface WireRow {
  agent_id: string | null;
  session_id: string | null;
  spec_hash: string | null;
  stdout_offset: number;
  next_request_id: number;
  state: string;
}

async function openDb(worker: Worker) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(join(worker.state, "chats.db"), { readOnly: true });
}

async function wireRow(worker: Worker, chatId: string): Promise<WireRow | undefined> {
  const db = await openDb(worker);
  try {
    return db.prepare("SELECT * FROM chat_wire_state WHERE chat_id = ?").get(chatId) as
      | WireRow
      | undefined;
  } finally {
    db.close();
  }
}

async function loggedTexts(worker: Worker, chatId: string): Promise<string[]> {
  const db = await openDb(worker);
  try {
    const rows = db
      .prepare("SELECT payload FROM chat_events WHERE chat_id = ? AND kind = 'update' ORDER BY id")
      .all(chatId) as Array<{ payload: string }>;
    const texts: string[] = [];
    for (const { payload } of rows) {
      const body = JSON.parse(payload) as {
        update?: { sessionUpdate?: string; content?: { text?: string } };
      };
      if (body.update?.sessionUpdate === "agent_message_chunk" && body.update.content?.text) {
        texts.push(body.update.content.text);
      }
    }
    return texts;
  } finally {
    db.close();
  }
}

/** What the agent daemon still holds of an agent's stdout, with the offset of its first byte. */
async function ringOf(
  worker: Worker,
  agentId: string,
  coverThrough = 0,
): Promise<{ start: number; bytes: Buffer }> {
  const holder = new AgentHolder({
    entry: "unused",
    runDir: agentRunDir(worker.state),
    cwd: worker.state,
    buildId: "test-reader",
  });
  try {
    const parts: Array<{ off: number; data: Buffer }> = [];
    const record = await holder.attach(
      agentId,
      { stdout: 0, stderr: 0 },
      {
        output: (stream, off, data) => {
          if (stream === "stdout") parts.push({ off, data });
        },
        exit: () => undefined,
      },
    );
    if (!record) throw new Error(`no daemon holds agent ${agentId}`);
    // The replay can trail the reply, and the agent may still be writing. Wait until the replay
    // covers `coverThrough` and then stops growing.
    let last = -1;
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const end = parts.reduce((m, p) => Math.max(m, p.off + p.data.length), 0);
      if (end >= coverThrough && end === last) break;
      last = end;
    }
    parts.sort((a, b) => a.off - b.off);
    const start = parts[0]?.off ?? 0;
    return { start, bytes: Buffer.concat(parts.map((p) => p.data)) };
  } finally {
    holder.close();
  }
}

async function send(worktreeId: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`${w.server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
}

describe("the offset in chats.db follows the committed events (S1, S3)", () => {
  it("is the end of the last committed line, however the worker is killed", async () => {
    let worker = await w.addWorker("w-offset", ["proj"], {
      ownChats: true,
      env: {
        BAND_TEST_ACP_SCENARIO: scenario,
        BAND_AGENT_REATTACH_TIMEOUT_MS: String(REATTACH_MS),
      },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-offset");
    for (let round = 0; round < 6; round++) {
      const chatId = `offset-chat-${round}`;
      await send(wt, chatId, `stream ${round}`);
      await waitFor(
        async () => {
          const texts = await loggedTexts(worker, chatId);
          return texts.length >= 3 + round * 7 ? true : undefined;
        },
        { label: "some of the reply to be logged", timeoutMs: 60_000 },
      ).catch(async (err: Error) => {
        const db = await openDb(worker);
        try {
          const perChat = db
            .prepare("SELECT chat_id, count(*) AS n FROM chat_events GROUP BY chat_id")
            .all();
          const wire = db
            .prepare("SELECT chat_id, agent_id, stdout_offset FROM chat_wire_state")
            .all();
          throw new Error(
            `${err.message}\nround ${round}\nrows: ${JSON.stringify(perChat)}\nwire: ${JSON.stringify(wire)}\n${worker.output()}`,
          );
        } finally {
          db.close();
        }
      });
      await w.killWorker(worker, "SIGKILL", { waitForLease: false });

      const row = await wireRow(worker, chatId);
      expect(row, "the client state was stored").toBeDefined();
      const stored = row?.stdout_offset ?? -1;
      expect(row?.agent_id).toBeTruthy();
      expect(row?.spec_hash).toMatch(/^[0-9a-f]{64}$/);
      const logged = new Set(await loggedTexts(worker, chatId));

      const ring = await ringOf(worker, row?.agent_id as string, stored);
      // S3: the daemon was never told to drop a byte this offset does not cover.
      expect(ring.start).toBeLessThanOrEqual(stored);
      // Not inside a line: the byte before the offset ends a line, unless the ring starts here.
      if (stored > ring.start) expect(ring.bytes[stored - ring.start - 1]).toBe(0x0a);
      // S1: every line that ends at or before the offset has its events, none after it does.
      let at = ring.start;
      let checked = 0;
      for (const line of ring.bytes.toString("utf8").split("\n")) {
        const end = at + Buffer.byteLength(line) + 1;
        at = end;
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as {
          method?: string;
          params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
        };
        const text = msg.params?.update?.content?.text;
        if (msg.params?.update?.sessionUpdate !== "agent_message_chunk" || !text) continue;
        if (!/^c\d{3}$/.test(text)) continue;
        checked++;
        expect(logged.has(text), `${text} ends at ${end}, stored offset ${stored}`).toBe(
          end <= stored,
        );
      }
      expect(checked).toBeGreaterThan(0);

      worker = await w.restartWorker(worker);
    }
  }, 300_000);
});

describe("the open requests, the turn and the queue are stored (S2)", () => {
  it("lists the permission request, the open prompt, the turn and the queued message", async () => {
    const worker = await w.addWorker("w-state", ["proj"], {
      ownChats: true,
      env: {
        BAND_TEST_ACP_SCENARIO: scenario,
        BAND_AGENT_REATTACH_TIMEOUT_MS: String(REATTACH_MS),
      },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-state");
    const chatId = "state-chat";
    await send(wt, chatId, "ask to run the tests");
    await waitFor(
      async () => {
        const row = await wireRow(worker, chatId);
        const state = row ? JSON.parse(row.state) : null;
        return state?.openAgentRequests?.some((r: { requestId?: string }) => r.requestId)
          ? true
          : undefined;
      },
      { label: "the permission request to be stored", timeoutMs: 60_000 },
    );
    await send(wt, chatId, "second message");
    await waitFor(
      async () => {
        const db = await openDb(worker);
        try {
          const n = db
            .prepare("SELECT count(*) AS n FROM queued_messages WHERE chat_id = ?")
            .get(chatId) as { n: number };
          return n.n === 1 ? true : undefined;
        } finally {
          db.close();
        }
      },
      { label: "the second message to be queued", timeoutMs: 30_000 },
    );
    // The turn and the prompt id are stored by the time the permission request is.
    await w.killWorker(worker, "SIGKILL", { waitForLease: false });

    const row = await wireRow(worker, chatId);
    const state = JSON.parse(row?.state ?? "{}") as {
      promptRequestId: number | string | null;
      openClientRequests: Array<{ id: number | string; method: string }>;
      openAgentRequests: Array<{ id: number | string; method: string; requestId?: string }>;
      turn: { seq: number; taskId: string; startedAt: number } | null;
    };
    expect(state.promptRequestId).not.toBeNull();
    expect(state.openClientRequests.find((r) => r.method === "session/prompt")?.id).toBe(
      state.promptRequestId,
    );
    expect(state.openAgentRequests).toHaveLength(1);
    const [open] = state.openAgentRequests;
    expect(open?.method).toBe("session/request_permission");
    expect(open?.id).toBeDefined();
    expect(state.turn?.taskId).toBeTruthy();
    expect(row?.next_request_id).toBeGreaterThan(Number(state.promptRequestId));

    const db = await openDb(worker);
    try {
      // The request id the open request carries is the one the log has, so nothing is duplicated.
      const logged = db
        .prepare("SELECT payload FROM chat_events WHERE chat_id = ? AND kind = 'permission'")
        .all(chatId) as Array<{ payload: string }>;
      expect(logged.map((r) => (JSON.parse(r.payload) as { requestId: string }).requestId)).toEqual(
        [open?.requestId],
      );
      const queued = db
        .prepare("SELECT payload FROM queued_messages WHERE chat_id = ?")
        .all(chatId) as Array<{ payload: string }>;
      expect(queued.map((r) => (JSON.parse(r.payload) as { text: string }).text)).toEqual([
        "second message",
      ]);
    } finally {
      db.close();
    }
    // S3: the permission request line is not acknowledged beyond what the log holds.
    const ring = await ringOf(worker, row?.agent_id as string, row?.stdout_offset ?? 0);
    expect(ring.start).toBeLessThanOrEqual(row?.stdout_offset ?? 0);
  }, 180_000);
});
