import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
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
const COUNTING_FLOOD = `perl -e '$|=1; my $l = ("x" x 150) . "\\n"; for (my $i = 1; ; $i++) { print $l; if ($i % 1000 == 0) { open(my $f, ">", "count.tmp"); print $f $i; close $f; rename "count.tmp", "count" } }'\r`;
/** The hold threshold plus generous slack for the PTY, socket and daemon buffers. */
const HELD_BYTES_BOUND = 4 * 1024 * 1024;
/**
 * How long output must stay flat to count as held. An unheld flood streams
 * tens of MB in this time.
 */
const HOLD_WATCH_MS = 1_000;
/**
 * The server writes off a client that acknowledges nothing for 5 s, which
 * would also resume the flood. Every check that the hold, an ack or a
 * disconnect did something finishes well inside that window, so the write-off
 * can't be what made it pass.
 */
const INSIDE_STALL_WINDOW_MS = 1_500;

const BACKENDS: [string, Record<string, string>][] = [
  ["terminal daemon", {}],
  ["in-process terminals", { BAND_TERMINAL_DAEMON: "0" }],
];

/**
 * Resolve once `read()` has not changed for `HOLD_WATCH_MS`. Bounded below
 * the 5 s stall write-off (with room for the check after it).
 */
async function waitForFlat(read: () => number, label: string): Promise<void> {
  let last = read();
  let since = Date.now();
  await waitFor(
    async () => {
      const now = read();
      if (now !== last) {
        last = now;
        since = Date.now();
        return undefined;
      }
      return Date.now() - since >= HOLD_WATCH_MS || undefined;
    },
    { timeoutMs: 3_000, intervalMs: 100, label },
  );
}

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

  async function openSocket(terminalId: string, flow: boolean): Promise<TerminalSocket> {
    return await TerminalSocket.open(server, {
      workspaceId: WORKSPACE_ID,
      terminalId,
      token: TOKEN,
      maxOutputChars: 64 * 1024,
      flow,
    });
  }

  async function openFlood(flow: boolean, terminalId?: string): Promise<TerminalSocket> {
    const socket = await openSocket(terminalId ?? (await createTerminal()), flow);
    socket.type(FLOOD);
    return socket;
  }

  /** Wait until an unacknowledged flood is past the threshold and has stopped arriving. */
  async function waitForHeld(socket: TerminalSocket): Promise<void> {
    await waitFor(async () => socket.bytes > 256 * 1024 || undefined, {
      timeoutMs: 15_000,
      label: "flood past the hold threshold",
    });
    await waitForFlat(() => socket.bytes, "flood held");
    expect(socket.bytes).toBeLessThan(HELD_BYTES_BOUND);
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
    await waitForHeld(socket);

    // Acknowledge everything received: the shell runs again, until the next
    // 256 KB are unacknowledged.
    const held = socket.bytes;
    socket.ack(held);
    await waitFor(async () => socket.bytes > held + 128 * 1024 || undefined, {
      timeoutMs: INSIDE_STALL_WINDOW_MS,
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
    await waitForHeld(first);
    await first.close();

    // A second viewer (one that doesn't acknowledge) sees the flood running
    // again: the first viewer's hold went with its socket.
    const second = await openSocket(terminalId, false);
    const replayed = second.bytes;
    await waitFor(async () => second.bytes > replayed + 1024 * 1024 || undefined, {
      timeoutMs: INSIDE_STALL_WINDOW_MS,
      label: "flood resumed for the second viewer",
    });
    await second.close();
  });

  it("paces a client that never opted in on what the server has buffered for it", {
    timeout: 60_000,
  }, async () => {
    const socket = await openSocket(await createTerminal(), false);
    socket.type(COUNTING_FLOOD);
    await waitFor(async () => linesPrinted() > 10_000 || undefined, {
      timeoutMs: 15_000,
      label: "flood under way",
    });

    // The client stops reading: once the kernel's socket buffers and 256 KB
    // in the server's send buffer fill, the shell is held and stops printing.
    socket.pause();
    await waitForFlat(linesPrinted, "shell held while the client isn't reading");

    const whilePaused = linesPrinted();
    socket.resume();
    await waitFor(async () => linesPrinted() > whilePaused + 10_000 || undefined, {
      timeoutMs: 15_000,
      label: "flood resumed once the client read again",
    });
    await socket.close();
  });

  it("writes off a client that stops acknowledging for 5 s", { timeout: 60_000 }, async () => {
    const socket = await openFlood(true);
    await waitForHeld(socket);
    const held = socket.bytes;
    // No ack at all: after the stall timeout the server stops waiting and
    // paces the client on its socket buffer instead, so one frozen tab can't
    // stall the terminal.
    await waitFor(async () => socket.bytes > held + HELD_BYTES_BOUND || undefined, {
      timeoutMs: 15_000,
      label: "flood resumed after the stall timeout",
    });
    await socket.close();
  });

  it("refuses the terminal socket without the token", async () => {
    // The upgrade is destroyed before the handshake, so the socket never opens.
    const url = new URL(server.url);
    const ws = new WebSocket(
      `ws://${url.host}/terminal?workspaceId=${encodeURIComponent(WORKSPACE_ID)}&terminalId=${randomUUID()}`,
    );
    const opened = await new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("error", () => resolve(false));
      ws.once("unexpected-response", () => resolve(false));
      ws.once("close", () => resolve(false));
    });
    ws.terminate();
    expect(opened).toBe(false);
  });
});
