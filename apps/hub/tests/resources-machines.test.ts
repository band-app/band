// The Resources page's data: memory and CPU of every machine and of the Band processes on it,
// and disk use measured on the machine that holds the files. A real hub, a real `band-worker`
// with a terminal and a chat whose agent is the scripted ACP stub.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

interface Proc {
  pid: number;
  kind: string;
  name: string;
  rssBytes: number;
  cpuPercent: number;
  worktree?: { id: string; repo: string; branch: string };
  chat?: { id: string; name: string; agent: string };
}
interface Machine {
  id: string;
  role: string;
  name: string;
  status: string;
  reason: string | null;
  snapshot: { memTotalBytes: number; cores: number; processes: Proc[] } | null;
}
interface Report {
  machines: Machine[];
}
interface Storage {
  worktrees: { id: string; repo: string; sizeBytes: number }[];
  state: { name: string; sizeBytes: number }[];
  disk: { totalBytes: number; freeBytes: number } | null;
}

let w: World;
let worker: Worker;
let worktreeId: string;
const chatId = "resources-chat";
const terminalId = crypto.randomUUID();

const snapshot = () => w.q<Report>("resources.snapshot");
const machineOf = (r: Report, id: string) => r.machines.find((m) => m.id === id);

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }] });
  worker = await w.addWorker("res-worker", ["proj"]);
  worktreeId = await w.createWorktree(worker, "proj", "feat-resources");
  await w.m("terminal.create", { worktreeId, id: terminalId });
  // One turn starts the agent process and keeps it for the chat.
  await w.turn(worktreeId, chatId, "hello");
}, 180_000);

afterAll(async () => {
  await w?.close();
});

describe("resources.snapshot", () => {
  it("lists the hub and the worker, with the terminal and the agent on the worker (S1)", async () => {
    const report = await waitFor(
      async () => {
        const r = await snapshot();
        const m = machineOf(r, worker.hostId);
        const procs = m?.snapshot?.processes ?? [];
        return procs.some((p) => p.kind === "terminal" && p.worktree) &&
          procs.some((p) => p.kind === "agent" && p.chat)
          ? r
          : undefined;
      },
      { label: "the worker's terminal and agent", timeoutMs: 60_000 },
    );
    expect(machineOf(report, "local")?.role).toBe("hub");
    expect(machineOf(report, "local")?.status).toBe("ok");
    const hubProcs = machineOf(report, "local")?.snapshot?.processes ?? [];
    expect(hubProcs.some((p) => p.kind === "hub" && p.rssBytes > 0)).toBe(true);
    // The command line and working directory stay on the worker.
    expect(JSON.stringify(report)).not.toContain('"command"');
    const procs = machineOf(report, worker.hostId)?.snapshot?.processes ?? [];
    expect(procs.some((p) => p.kind === "worker")).toBe(true);
    // The wait above ends once some terminal has a worktree. The report can hold another terminal
    // root that has none yet (macOS CI failed on the first one), so pick the one the wait saw.
    const all = JSON.stringify(procs);
    const terminal = procs.find((p) => p.kind === "terminal" && p.worktree);
    expect(terminal?.rssBytes, all).toBeGreaterThan(0);
    expect(terminal?.worktree?.id, all).toBe(worktreeId);
    const agent = procs.find((p) => p.kind === "agent" && p.chat);
    expect(agent?.rssBytes, all).toBeGreaterThan(0);
    expect(agent?.worktree?.id, all).toBe(worktreeId);
    expect(agent?.chat?.id, all).toBe(chatId);
  });

  it("ranks a busy loop in the terminal first by CPU (S2)", async () => {
    // Wait for the shell's prompt, or the loop would be typed before the shell reads input.
    const socket = await TerminalSocket.open(w.server, {
      worktreeId,
      terminalId,
      token: TEST_TOKEN,
    });
    await waitFor(async () => (socket.output.length > 0 ? true : undefined), {
      label: "the shell's prompt",
      timeoutMs: 30_000,
    });
    try {
      await w.m("terminal.send", { terminalId, data: "while :; do :; done\n" });
      const top = await waitFor(
        async () => {
          const m = machineOf(await snapshot(), worker.hostId);
          const procs = [...(m?.snapshot?.processes ?? [])].sort(
            (a, b) => b.cpuPercent - a.cpuPercent,
          );
          return procs[0]?.kind === "terminal" && procs[0].cpuPercent > 20 ? procs[0] : undefined;
        },
        { label: "the busy terminal on top", timeoutMs: 60_000 },
      );
      expect(top.worktree?.id).toBe(worktreeId);
    } finally {
      // Stop the loop so it does not slow the rest of the suite, even when an assertion failed.
      await w.m("terminal.send", { terminalId, data: "\u0003" }).catch(() => {});
      socket.close();
    }
  }, 120_000);

  it("measures worktrees on the worker itself, not on the hub (S3)", async () => {
    const storage = await w.q<Storage>("resources.storage", { hostId: worker.hostId });
    const row = storage.worktrees.find((x) => x.id === worktreeId);
    expect(row?.repo).toBe("proj");
    // `hello.txt` plus the checkout's git files: well above zero.
    expect(row?.sizeBytes).toBeGreaterThan(0);
    expect(storage.state.length).toBeGreaterThan(0);
    expect(storage.disk?.freeBytes).toBeGreaterThan(0);
    expect(storage.disk?.totalBytes).toBeGreaterThan(storage.disk?.freeBytes ?? 0);
    // The hub holds no copy of this worktree, so its own storage does not list it.
    const hub = await w.q<Storage>("resources.storage", { hostId: "local" });
    expect(hub.worktrees.find((x) => x.id === worktreeId)).toBeUndefined();
  });

  it("refuses a request with no token", async () => {
    const snap = await fetch(`${w.server.url}/trpc/resources.snapshot`);
    expect(snap.status).toBe(401);
    const input = encodeURIComponent(JSON.stringify({ hostId: "local" }));
    const storage = await fetch(`${w.server.url}/trpc/resources.storage?input=${input}`);
    expect(storage.status).toBe(401);
  });

  it("the MCP endpoint does not list the procedures (S5, the relay 403 is in remote-relay.test.ts)", async () => {
    const res = await fetch(`${w.server.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Cookie: `band_token=${TEST_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("band_worktrees_");
    expect(text).not.toContain("band_resources_");
  });

  it("shows a stopped worker as unavailable and still renders the rest (S4)", async () => {
    await w.killWorker(worker, "SIGKILL", { waitForLease: false });
    const report = await waitFor(
      async () => {
        const r = await snapshot();
        return machineOf(r, worker.hostId)?.status === "unavailable" ? r : undefined;
      },
      { label: "the stopped worker shown unavailable", timeoutMs: 30_000 },
    );
    const m = machineOf(report, worker.hostId);
    expect(m?.status).toBe("unavailable");
    expect(m?.reason).toBe("offline");
    expect(m?.snapshot).toBeNull();
    expect(machineOf(report, "local")?.status).toBe("ok");
  });
});
