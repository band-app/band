import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Channel, ServerSession } from "@band-app/link";
import {
  call,
  cleanup,
  decode,
  startHub,
  startWorker,
  type TestHub,
  type TestWorker,
  waitFor,
} from "./helpers.ts";

interface Attached {
  ch: Channel;
  snapshot: string;
}

/** Every shell this suite started, so the suite can check none outlives it. */
const shellPids = new Set<number>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnTerminal(
  w: TestWorker,
  terminalId: string,
  options?: { command?: string },
): Promise<void> {
  const entry = await call<{ pid: number }>(w.session, "pty.spawn", {
    worktreeId: "ws",
    terminalId,
    worktreeRoot: w.root,
    options,
  });
  shellPids.add(entry.pid);
}

async function attach(
  session: ServerSession,
  terminalId: string,
  extra: Record<string, unknown> = {},
): Promise<Attached> {
  const res = (await session.request("pty.attach", {
    terminalId,
    dims: { cols: 80, rows: 24 },
    ...extra,
  })) as { chan: number; snapshot: Parameters<typeof decode>[1] };
  const ch = session.getChannel(res.chan);
  assert.ok(ch, "the channel opens before the reply arrives");
  return { ch, snapshot: (await decode(session, res.snapshot)) as string };
}

/** Collects what a channel delivers, as text, in the background. */
function collect(ch: Channel): { text(): string; done: Promise<void> } {
  let text = "";
  const done = (async () => {
    try {
      for await (const chunk of ch) text += chunk.toString();
    } catch {
      // A reset ends the loop.
    }
  })();
  return { text: () => text, done };
}

describe("terminals over the link", () => {
  let hub: TestHub;
  let w: TestWorker;

  before(async () => {
    hub = await startHub();
    w = await startWorker(hub);
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir);
    // The worker's stop kills every shell, and a killed shell is escalated to SIGKILL, so none may remain.
    await waitFor(
      () => [...shellPids].every((pid) => !isAlive(pid)),
      10_000,
      `shells to exit, still alive: ${[...shellPids].filter(isAlive).join(", ")}`,
    );
  });

  // S3
  it("runs a command and streams its output", async () => {
    // The pool runs the command as soon as the shell prints its prompt. On a fast
    // machine that is before this attach, so the output is already in the snapshot,
    // and on a slow one it arrives on the channel. Either way the viewer sees it.
    await spawnTerminal(w, "echo", { command: "echo $((6*7))marker" });
    const { ch, snapshot } = await attach(w.session, "echo");
    const out = collect(ch);
    await waitFor(() => (snapshot + out.text()).includes("42marker"), 8000, "echo output");
    ch.reset();
  });

  it("streams a command's output on the channel after the viewer attached", async () => {
    await spawnTerminal(w, "echo-live");
    const { ch } = await attach(w.session, "echo-live");
    const out = collect(ch);
    await ch.send(Buffer.from("echo $((6*7))live\n"));
    await waitFor(() => out.text().includes("42live"), 8000, "live echo output");
    ch.reset();
  });

  it("serves an interactive shell, and a resize reaches it", async () => {
    await spawnTerminal(w, "shell");
    const { ch } = await attach(w.session, "shell");
    const out = collect(ch);

    await ch.send(Buffer.from("echo $((20+22))done\n"));
    await waitFor(() => out.text().includes("42done"), 8000, "shell output");

    await call(w.session, "pty.resize", { terminalId: "shell", cols: 100, rows: 30 });
    await ch.send(Buffer.from("echo size=$(stty size)\n"));
    await waitFor(() => /size=30 100/.test(out.text()), 8000, "resized dimensions");
    ch.reset();
  });

  it("replays the screen to a second viewer as a snapshot", async () => {
    await spawnTerminal(w, "replay");
    const first = await attach(w.session, "replay");
    const out = collect(first.ch);
    await first.ch.send(Buffer.from("echo replayed-$((1+1))\n"));
    await waitFor(() => out.text().includes("replayed-2"), 8000, "first viewer output");
    first.ch.reset();

    const second = await attach(w.session, "replay");
    assert.match(second.snapshot, /replayed-2/);
    second.ch.reset();
    const info = await call<{ terminalId: string } | null>(w.session, "pty.info", {
      terminalId: "replay",
    });
    assert.equal(info?.terminalId, "replay", "closing a plain viewer leaves the terminal running");
  });

  it("kills the terminal when its channel closes with killOnClose", async () => {
    await spawnTerminal(w, "doomed");
    const { ch } = await attach(w.session, "doomed", { killOnClose: true });
    const exited = new Promise<{ terminalId: string; killed: boolean }>((resolve) =>
      w.session.onNotification("pty.exit", (p) => {
        const event = p as { terminalId: string; killed: boolean };
        if (event.terminalId === "doomed") resolve(event);
      }),
    );
    ch.end();
    assert.equal((await exited).killed, true);
    assert.equal(await call(w.session, "pty.info", { terminalId: "doomed" }), null);
  });

  it("ends the channel when the shell exits", async () => {
    await spawnTerminal(w, "short");
    const { ch } = await attach(w.session, "short");
    const out = collect(ch);
    await ch.send(Buffer.from("exit\n"));
    await out.done; // resolves only when the worker ends the channel
  });

  // S4
  it("loses no output when the socket is killed in the middle of a stream", async () => {
    const lines = 4000;
    // Attach first and start the flood through the channel, so no output predates the viewer.
    await spawnTerminal(w, "flood");
    const { ch } = await attach(w.session, "flood");
    await ch.send(
      Buffer.from(
        `for i in $(seq 1 ${lines}); do echo "line-$i-${"x".repeat(80)}"; done; echo FINISHED\n`,
      ),
    );

    let received = 0;
    let text = "";
    let drops = 0;
    let nextDrop = 40_000;
    for await (const chunk of ch) {
      text += chunk.toString();
      received += chunk.length;
      if (received >= nextDrop && drops < 5) {
        drops++;
        nextDrop += 60_000;
        w.session.dropConnection();
      }
      // The typed command is echoed back and ends in "echo FINISHED", so match a line of its own.
      if (/^FINISHED\r?$/m.test(text)) break;
    }
    assert.ok(drops >= 3, `dropped the socket ${drops} times`);

    const seen = [...text.matchAll(/^line-(\d+)-x{80}\r?$/gm)].map((m) => Number(m[1]));
    assert.equal(seen.length, lines, "every line arrived");
    assert.deepEqual(
      seen,
      Array.from({ length: lines }, (_, i) => i + 1),
      "in order, with no gap or repeat",
    );
    ch.reset();
  });
});
