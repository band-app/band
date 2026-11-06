// Integration tests for the agents of chats a worker owns: a real hub and a real `band-worker`
// started with `--own-chats`, dialing the hub through a proxy the test can cut. The worker holds
// each owned chat's agent in its agent daemon, so a worker restart leaves the agent running. The
// coding agent is the scripted ACP stub. The stub logs its own pid with every request, which is
// how the tests find the agent process.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentText } from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { type CuttableProxy, startCuttableProxy } from "./helpers/cuttable-proxy";
import { waitFor } from "./helpers/wait-for";

/** The daemon kills an agent nobody watches this long (plus its 2 s margin and 2 s sweep). */
const REATTACH_MS = 2000;
const ORPHAN_WAIT_MS = REATTACH_MS + 2000 + 2000 + 3000;

let w: World;
let owner: Worker;
let proxy: CuttableProxy;
let wt = "";
const chatId = "owned-daemon-chat";

/** The pids of the agent processes the worker's stub agent logged, in start order. */
function agentPids(worker: Worker): number[] {
  const pids: number[] = [];
  for (const line of readFileSync(worker.stubLog, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const { pid } = JSON.parse(line) as { pid?: number };
      if (typeof pid === "number" && !pids.includes(pid)) pids.push(pid);
    } catch {
      // A half-written last line is not a line yet.
    }
  }
  return pids;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const hostStatus = async () =>
  (await w.q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
    (h) => h.id === owner.hostId,
  )?.status;

beforeAll(async () => {
  w = await startWorld({
    repos: [{ name: "proj" }],
    // A long lease: the cut link in S3 must not fence the worker.
    env: { BAND_WORKER_LEASE_MS: "120000" },
  });
  proxy = await startCuttableProxy(w.server.url);
  owner = await w.addWorker("owner", ["proj"], {
    ownChats: true,
    hubUrl: proxy.url,
    env: { BAND_AGENT_REATTACH_TIMEOUT_MS: String(REATTACH_MS) },
  });
  wt = await w.createWorktree(owner, "proj", "feat-owned-daemon");
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  for (const pid of owner ? agentPids(owner) : []) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await w?.close();
});

describe("the agent of an owned chat outlives the worker (S1, S2, S5)", () => {
  let first = 0;

  it("keeps the agent running, with the same pid, after the worker gets SIGTERM", async () => {
    const events = await w.turn(wt, chatId, "hello");
    expect(agentText(events)).toContain("hello");
    first = agentPids(owner)[0] ?? 0;
    expect(first).toBeGreaterThan(0);

    await w.killWorker(owner, "SIGTERM", { waitForLease: false });
    expect(alive(first)).toBe(true);
  }, 90_000);

  it("kills the held agent once nothing reattaches within the timeout", async () => {
    await waitFor(() => (alive(first) ? undefined : true), {
      label: "the daemon to kill the orphaned owned agent",
      timeoutMs: ORPHAN_WAIT_MS + 5000,
    });
  }, 60_000);

  it("runs the next message on a new agent, and leaves one agent running", async () => {
    owner = await w.restartWorker(owner);
    const events = await w.turn(wt, chatId, "after the restart");
    expect(agentText(events)).toContain("after the restart");
    const pids = agentPids(owner);
    const second = pids[pids.length - 1] ?? 0;
    expect(second).not.toBe(first);
    expect(alive(second)).toBe(true);
    expect(pids.filter(alive)).toEqual([second]);
  }, 90_000);
});

describe("a cut link does not end an owned agent (S3)", () => {
  it("keeps the agent past the reattach timeout while the hub is unreachable", async () => {
    const pids = agentPids(owner);
    const running = pids[pids.length - 1] ?? 0;
    expect(alive(running)).toBe(true);

    await proxy.cut();
    await waitFor(async () => ((await hostStatus()) !== "online" ? true : undefined), {
      label: "the hub sees the worker go",
      timeoutMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, ORPHAN_WAIT_MS + 2000));
    expect(alive(running)).toBe(true);

    await proxy.restore();
    await waitFor(async () => ((await hostStatus()) === "online" ? true : undefined), {
      label: "the worker back online",
      timeoutMs: 60_000,
    });
    // The hub reconciles held agents on every connect and knows none of an owned chat's.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(alive(running)).toBe(true);
  }, 120_000);
});
