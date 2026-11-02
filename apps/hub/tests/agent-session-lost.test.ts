// A chat whose agent session died inside a live adapter (the Claude adapter keeps running after
// its `claude` child is killed, then answers every prompt -32603 "Session not found"). The next
// message must restart the adapter, reattach the saved session and run once more. The stub agent
// plays the adapter (`sessionLost` and `failDetails` steps); the request log shows the restart.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentText,
  maxId,
  runTurn,
  type StubRequest,
  startAcpServer,
  stubRequests,
  turnEnded,
} from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import type { ServerHandle } from "./helpers/server";

const TURNS = [
  { match: "^lost-once", steps: [{ sessionLost: "once" }, { say: "Recovered." }] },
  { match: "^lost-forget", steps: [{ sessionLost: "forget" }] },
  { match: "^lost-always", steps: [{ sessionLost: true }] },
  { match: "^detail", steps: [{ failDetails: "Quota exceeded" }] },
];

const reattaches = (log: StubRequest[]) =>
  log.filter((r) => r.method === "session/resume" || r.method === "session/load");

const lastTurnEnd = (events: Parameters<typeof agentText>[0]) => events.filter(turnEnded).at(-1);

describe("a hub-run chat (S1, S3, S4)", () => {
  let server: ServerHandle | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const prompts = (s: ServerHandle) => stubRequests(s.home, "session/prompt");

  it("restarts the adapter, reattaches the session and completes the turn", async () => {
    server = await startAcpServer({ turns: TURNS });
    // The first turn creates the session on the first process.
    const first1 = await runTurn(server.url, "lost-1", "hello");
    const firstProc = stubRequests(server.home, "session/new")[0];
    const sessionId = (
      stubRequests(server.home, "session/prompt")[0]?.params as { sessionId: string }
    ).sessionId;
    const events = await runTurn(server.url, "lost-1", "lost-once please", maxId(first1));
    expect(agentText(events)).toContain("Recovered.");
    expect(lastTurnEnd(events)).not.toHaveProperty("error");
    const log = stubRequests(server.home);
    const again = reattaches(log).filter(
      (r) => (r.params as { sessionId: string }).sessionId === sessionId,
    );
    expect(again.length).toBeGreaterThan(0);
    expect(again.every((r) => r.pid !== firstProc?.pid)).toBe(true);
    expect(
      prompts(server).filter((r) => String(JSON.stringify(r.params)).includes("lost-once")),
    ).toHaveLength(2);
  }, 90_000);

  it("fails once with the real reason when the session can't be reattached", async () => {
    server = await startAcpServer({ turns: TURNS });
    const first2 = await runTurn(server.url, "lost-2", "hello");
    const events = await runTurn(server.url, "lost-2", "lost-forget please", maxId(first2));
    const ended = lastTurnEnd(events) as { error?: string } | undefined;
    expect(ended?.error).toMatch(/Session not found|not found/i);
    const sent = prompts(server).filter((r) => JSON.stringify(r.params).includes("lost-forget"));
    expect(sent).toHaveLength(1);
  }, 90_000);

  it("retries at most once when the session is lost again", async () => {
    server = await startAcpServer({ turns: TURNS });
    const first3 = await runTurn(server.url, "lost-3", "hello");
    const events = await runTurn(server.url, "lost-3", "lost-always please", maxId(first3));
    const ended = lastTurnEnd(events) as { error?: string } | undefined;
    expect(ended?.error).toContain("Session not found");
    const sent = prompts(server).filter((r) => JSON.stringify(r.params).includes("lost-always"));
    expect(sent).toHaveLength(2);
  }, 90_000);

  it("does not restart for another error and keeps its details in the message", async () => {
    server = await startAcpServer({ turns: TURNS });
    const first4 = await runTurn(server.url, "lost-4", "hello");
    const events = await runTurn(server.url, "lost-4", "detail please", maxId(first4));
    const ended = lastTurnEnd(events) as { error?: string } | undefined;
    expect(ended?.error).toContain("Quota exceeded");
    expect(reattaches(stubRequests(server.home))).toHaveLength(0);
    const sent = prompts(server).filter((r) => JSON.stringify(r.params).includes("detail please"));
    expect(sent).toHaveLength(1);
  }, 90_000);
});

describe("a chat a worker owns (S2)", () => {
  let w: World;
  let owner: Worker;
  let wt: string;

  beforeAll(async () => {
    w = await startWorld({ repos: [{ name: "proj" }] });
    const scenario = join(w.tmp("band-lost-scenario-"), "scenario.json");
    writeFileSync(scenario, JSON.stringify({ turns: TURNS }));
    owner = await w.addWorker("owner", ["proj"], {
      ownChats: true,
      env: { BAND_TEST_ACP_SCENARIO: scenario },
    });
    wt = await w.createWorktree(owner, "proj", "feat-lost");
  }, 120_000);

  afterAll(async () => {
    await w?.close();
  });

  it("restarts the adapter on the worker and completes the turn", async () => {
    await w.turn(wt, "owned-lost", "hello");
    const events = await w.turn(wt, "owned-lost", "lost-once please");
    expect(agentText(events)).toContain("Recovered.");
    expect(lastTurnEnd(events)).not.toHaveProperty("error");
    const all = (w.stubRequests(owner, "session/prompt") as unknown as StubRequest[]).filter((r) =>
      JSON.stringify(r.params).includes("lost-once"),
    );
    expect(all).toHaveLength(2);
    expect(all[0]?.pid).not.toBe(all[1]?.pid);
  }, 120_000);

  it("fails once with the real reason when the session can't be reattached", async () => {
    await w.turn(wt, "owned-lost-2", "hello");
    const events = await w.turn(wt, "owned-lost-2", "lost-forget please");
    const ended = lastTurnEnd(events) as { error?: string } | undefined;
    expect(ended?.error).toMatch(/Session not found|not found/i);
    const sent = (w.stubRequests(owner, "session/prompt") as unknown as StubRequest[]).filter((r) =>
      JSON.stringify(r.params).includes("lost-forget"),
    );
    expect(sent).toHaveLength(1);
  }, 120_000);
});
