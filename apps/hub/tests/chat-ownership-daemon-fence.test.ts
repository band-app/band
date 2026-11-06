// An owned chat's agent in the agent daemon is killed when the worker's lease runs out. A real hub
// and a real `band-worker` started with `--own-chats` dial the hub through a proxy the test cuts.
// The test hub's lease is short (helpers/checkpoint-world.ts, LEASE_MS), so a cut past it fences
// the worker, and the daemon enforces the same lease on the agents it holds.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentText } from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { type CuttableProxy, startCuttableProxy } from "./helpers/cuttable-proxy";
import { waitFor } from "./helpers/wait-for";

let w: World;
let owner: Worker;
let proxy: CuttableProxy;

function agentPid(worker: Worker): number {
  for (const line of readFileSync(worker.stubLog, "utf8").split("\n")) {
    try {
      const { pid } = JSON.parse(line) as { pid?: number };
      if (typeof pid === "number") return pid;
    } catch {
      // A half-written line is not a line yet.
    }
  }
  return 0;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }] });
  proxy = await startCuttableProxy(w.server.url);
  owner = await w.addWorker("owner", ["proj"], { ownChats: true, hubUrl: proxy.url });
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  await w?.close();
});

describe("the lease runs out (S4)", () => {
  it("kills the owned chat's agent held by the daemon", async () => {
    const wt = await w.createWorktree(owner, "proj", "feat-owned-fence");
    const events = await w.turn(wt, "owned-fence-chat", "hello");
    expect(agentText(events)).toContain("hello");
    const pid = agentPid(owner);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);

    await proxy.cut();
    await waitFor(() => (alive(pid) ? undefined : true), {
      label: "the daemon to kill the agent when the lease ran out",
      timeoutMs: 30_000,
    });
  }, 120_000);
});
