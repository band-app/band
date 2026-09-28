import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

// Parse-acknowledged backpressure (`api/terminals/output-flow.ts`). A browser
// that attaches with `flow: true` acknowledges output once xterm has parsed
// it, and the server pauses the PTY while more than 256 KB is
// unacknowledged, so a flooding shell blocks instead of burying the user's
// echo under megabytes the browser hasn't parsed yet. Covered for both
// backends: the daemon (hold/release notifies) and in-process PTYs.

const TOKEN = "terminal-output-flow-token";
const PROJECT = "flowproj";
const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
const FLOOD = `perl -e '$|=1; my $l = ("x" x 150) . "\\n"; print $l while 1'\r`;
/** A flood that also records how many lines it has printed, in `count` in its cwd. */
const COUNTING_FLOOD = `perl -e '$|=1; my $l = ("x" x 150) . "\n"; for (my $i = 1; ; $i++) { print $l; if ($i % 1000 == 0) { open(my $f, ">", "count.tmp"); print $f $i; close $f; rename "count.tmp", "count" } }'\r`;
/** The hold threshold plus generous slack for the PTY, socket and daemon buffers. */
const HELD_BYTES_BOUND = 4 * 1024 * 1024;
/** How long a held flood is watched for growth. An unheld one streams tens of MB in this time. */
const HOLD_WATCH_MS = 1_000;

const BACKENDS: [string, Record<string, string>][] = [
  ["terminal daemon", {}],
  ["in-process terminals", { BAND_TERMINAL_DAEMON: "0" }],
];

describe.each(BACKENDS)("terminal output backpressure (%s)", (_name, env) => {
  let tmpHome: string;
  let worktree: string;
  let server: ServerHandle;

  function linesPrinted(): number {
    try {
      return Number(readFileSync(join(worktree, "count"), "utf8"));
    } catch {
      return 0;
    }
  }

  async function createTerminal(): Promise<string> {
    const terminalId = randomUUID();
    const res = await trpcMutate(
      server.url,
      "terminal.create",
      { workspaceId: WORKSPACE_ID, id: terminalId },
      TOKEN,
    );
    expect(res.status).toBe(200);
    return terminalId;
  }

  async function openFlood(flow: boolean, terminalId?: string): Promise<TerminalSocket> {
    const socket = await TerminalSocket.open(server, {
      workspaceId: WORKSPACE_ID,
      terminalId: terminalId ?? (await createTerminal()),
      token: TOKEN,
      maxOutputChars: 64 * 1024,
      flow,
    });
    socket.type(FLOOD);
    return socket;
  }

  /** Output received over `HOLD_WATCH_MS`, once the flood is past the hold threshold. */
  async function growthWhileUnacked(socket: TerminalSocket): Promise<number> {
    await waitFor(async () => socket.bytes > 256 * 1024 || undefined, {
      timeoutMs: 15_000,
      label: "flood past the hold threshold",
    });
    // Let bytes already read from the PTY before the hold arrive.
    await sleep(HOLD_WATCH_MS);
    const before = socket.bytes;
    await sleep(HOLD_WATCH_MS);
    return socket.bytes - before;
  }

  beforeAll(async () => {
    tmpHome = createTmpHome("band-output-flow-");
    worktree = join(tmpHome, PROJECT);
    mkdirSync(worktree, { recursive: true });
    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: worktree,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: worktree }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome, env });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("pauses a flooding shell while its output is unacknowledged, and resumes on ack", {
    timeout: 60_000,
  }, async () => {
    const socket = await openFlood(true);

    expect(await growthWhileUnacked(socket)).toBe(0);
    expect(socket.bytes).toBeLessThan(HELD_BYTES_BOUND);

    // Acknowledge everything received: the shell runs again, until the next
    // 256 KB are unacknowledged.
    const held = socket.bytes;
    socket.ack(held);
    await waitFor(async () => socket.bytes > held + 128 * 1024 || undefined, {
      timeoutMs: 15_000,
      label: "flood resumed after the ack",
    });
    await socket.close();
  });

  it("does not hold a client that never opted into acknowledgements", {
    timeout: 60_000,
  }, async () => {
    const socket = await openFlood(false);
    await waitFor(async () => socket.bytes > 4 * HELD_BYTES_BOUND || undefined, {
      timeoutMs: 30_000,
      label: "flood well past the hold threshold",
    });
    await socket.close();
  });

  it("releases the hold when the client disconnects", { timeout: 60_000 }, async () => {
    const terminalId = await createTerminal();
    const first = await openFlood(true, terminalId);
    await growthWhileUnacked(first);
    await first.close();

    // A second viewer (one that doesn't acknowledge) sees the flood running
    // again: the first viewer's hold went with its socket.
    const second = await TerminalSocket.open(server, {
      workspaceId: WORKSPACE_ID,
      terminalId,
      token: TOKEN,
      maxOutputChars: 64 * 1024,
    });
    await waitFor(async () => second.bytes > HELD_BYTES_BOUND || undefined, {
      timeoutMs: 15_000,
      label: "flood resumed for the second viewer",
    });
    await second.close();
  });

  it("paces a client that never opted in on what the server has buffered for it", {
    timeout: 60_000,
  }, async () => {
    const socket = await TerminalSocket.open(server, {
      workspaceId: WORKSPACE_ID,
      terminalId: await createTerminal(),
      token: TOKEN,
      maxOutputChars: 64 * 1024,
    });
    socket.type(COUNTING_FLOOD);
    await waitFor(async () => linesPrinted() > 10_000 || undefined, {
      timeoutMs: 15_000,
      label: "flood under way",
    });

    // The client stops reading: once the kernel's socket buffers and 256 KB
    // in the server's send buffer fill, the shell is held and stops printing.
    socket.pause();
    await sleep(2 * HOLD_WATCH_MS);
    const whilePaused = linesPrinted();
    await sleep(HOLD_WATCH_MS);
    expect(linesPrinted()).toBe(whilePaused);

    socket.resume();
    await waitFor(async () => linesPrinted() > whilePaused + 10_000 || undefined, {
      timeoutMs: 15_000,
      label: "flood resumed once the client read again",
    });
    await socket.close();
  });

  it("writes off a client that stops acknowledging for 5 s", { timeout: 60_000 }, async () => {
    const socket = await openFlood(true);
    await growthWhileUnacked(socket);
    const held = socket.bytes;
    // No ack at all: after the stall timeout the server stops waiting and the
    // flood streams again, so one frozen tab can't stall the terminal.
    await waitFor(async () => socket.bytes > held + 256 * 1024 || undefined, {
      timeoutMs: 15_000,
      label: "flood resumed after the stall timeout",
    });
    await socket.close();
  });
});
