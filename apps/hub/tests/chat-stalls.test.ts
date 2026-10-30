// Issue #1039: a chat must never sit in `running` with no agent turn behind it, and a message sent
// to a chat must start a turn. A real hub, a real `band-worker` behind a link a test can cut, and
// the scripted ACP stub agent.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { type CuttableProxy, startCuttableProxy } from "./helpers/cuttable-proxy";
import { waitFor } from "./helpers/wait-for";

let w: World;
let proxy: CuttableProxy;
let worker: Worker;
let wt: string;

const SCENARIO = {
  turns: [
    // Streams, goes quiet long enough to cut the link, then finishes.
    { match: "^slow", steps: [{ say: "A1 " }, { sleep: 5000 }, { say: "A2" }] },
    { match: "^hang", steps: [{ say: "Working." }, { waitForCancel: true }] },
    // The agent process kills itself without a word.
    { match: "^die", steps: [{ say: "D1 " }, { sleep: 3000 }, { kill: "SIGKILL" }] },
  ],
};

const status = async (chatId: string) =>
  (await w.q<{ chat: { status: string } | null }>("chats.get", { chatId })).chat?.status;

async function send(chatId: string, message: string) {
  return w.m<{ queued: boolean }>("chats.send", { worktreeId: wt, chatId, message });
}

/** The prompts the agent received, in order. */
const prompts = () =>
  w
    .stubRequests(worker, "session/prompt")
    .map((r) => JSON.stringify((r as { params: unknown }).params));

const agentGot = (text: string, timeoutMs = 40_000) =>
  waitFor(() => (prompts().some((p) => p.includes(text)) ? true : undefined), {
    label: `the agent receives "${text}"`,
    timeoutMs,
  });

beforeAll(async () => {
  w = await startWorld({
    repos: [{ name: "proj" }],
    env: { BAND_WORKER_LEASE_MS: "120000", BAND_AGENT_REATTACH_TIMEOUT_MS: "60000" },
  });
  proxy = await startCuttableProxy(w.server.url);
  const scenario = join(w.tmp("band-stalls-scenario-"), "scenario.json");
  writeFileSync(scenario, JSON.stringify(SCENARIO));
  worker = await w.addWorker("stall", ["proj"], {
    hubUrl: proxy.url,
    env: { BAND_TEST_ACP_SCENARIO: scenario },
  });
  wt = await w.createWorktree(worker, "proj", "feat-stalls");
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  await w?.close();
});

describe("stop then send (S3)", () => {
  it("starts a turn for a message sent while the stop is still settling, and keeps the older queue paused", async () => {
    const chatId = "stop-send";
    await w.m("chats.create", { worktreeId: wt, id: chatId, name: "Chat" });
    await send(chatId, "hang");
    await agentGot("hang");
    expect((await send(chatId, "queued before the stop")).queued).toBe(true);
    await w.m("chats.stop", { chatId });
    await send(chatId, "after the stop");
    await agentGot("after the stop", 20_000);
    expect(prompts().some((p) => p.includes("queued before the stop"))).toBe(false);
  }, 60_000);
});

describe("a cut link mid-turn (S1)", () => {
  it("completes the turn after the link resumes", async () => {
    const chatId = "cut-mid-turn";
    await w.m("chats.create", { worktreeId: wt, id: chatId, name: "Chat" });
    await send(chatId, "slow please");
    await agentGot("slow please");
    await new Promise((r) => setTimeout(r, 1000));
    await proxy.cut();
    await new Promise((r) => setTimeout(r, 1500));
    await proxy.restore();
    const ended = await waitFor(
      async () => {
        const s = await status(chatId);
        return s && s !== "running" ? s : undefined;
      },
      { label: "the chat leaves running", timeoutMs: 40_000 },
    );
    // The link resumed, so the agent's second part arrived and the turn completed (idle, not error).
    expect(ended).toBe("idle");
  }, 90_000);
});

describe("an agent that died while the hub could not see it (S2)", () => {
  it("fails the turn well before the reattach give-up, then runs the next message", async () => {
    const chatId = "died-unseen";
    await w.m("chats.create", { worktreeId: wt, id: chatId, name: "Chat" });
    await send(chatId, "die now");
    await agentGot("die now");
    // The stub kills itself 3 s into the turn, inside this cut: the worker's `acp.exit` is lost.
    await proxy.cut();
    await new Promise((r) => setTimeout(r, 5000));
    await proxy.restore();
    // The give-up for a lost link is 60 s in this world; the hub must not wait for it.
    const ended = await waitFor(
      async () => {
        const s = await status(chatId);
        return s && s !== "running" ? s : undefined;
      },
      { label: "the turn ends", timeoutMs: 25_000 },
    );
    expect(ended).toBe("error");
    await send(chatId, "queued after death");
    await agentGot("queued after death");
  }, 120_000);
});

describe("the stall watchdog (S2, a worker that never comes back)", () => {
  it("ends a turn whose agent is cut off and silent", async () => {
    // A reattach window far longer than the test, so only the watchdog can end the turn.
    const w2 = await startWorld({
      repos: [{ name: "proj" }],
      env: {
        BAND_WORKER_LEASE_MS: "120000",
        BAND_AGENT_REATTACH_TIMEOUT_MS: "600000",
        BAND_TURN_STALL_MS: "4000",
      },
    });
    const proxy2 = await startCuttableProxy(w2.server.url);
    try {
      const scenario = join(w2.tmp("band-stalls-wd-"), "scenario.json");
      writeFileSync(
        scenario,
        JSON.stringify({ turns: [{ steps: [{ say: "x" }, { sleep: 600000 }] }] }),
      );
      const worker2 = await w2.addWorker("wd", ["proj"], {
        hubUrl: proxy2.url,
        env: { BAND_TEST_ACP_SCENARIO: scenario },
      });
      const wt2 = await w2.createWorktree(worker2, "proj", "feat-wd");
      const chatId = "watchdog";
      await w2.m("chats.create", { worktreeId: wt2, id: chatId, name: "Chat" });
      await w2.m("chats.send", { worktreeId: wt2, chatId, message: "go" });
      await waitFor(
        () => (w2.stubRequests(worker2, "session/prompt").length > 0 ? true : undefined),
        { label: "the agent receives the prompt", timeoutMs: 40_000 },
      );
      await proxy2.cut();
      const ended = await waitFor(
        async () => {
          const { chat } = await w2.q<{ chat: { status: string } | null }>("chats.get", { chatId });
          return chat && chat.status !== "running" ? chat.status : undefined;
        },
        { label: "the watchdog ends the turn", timeoutMs: 30_000 },
      );
      expect(ended).toBe("error");
    } finally {
      await proxy2.close();
      await w2.close();
    }
  }, 120_000);
});
