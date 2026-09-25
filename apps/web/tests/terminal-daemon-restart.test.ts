import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { toWorkspaceId } from "@/dashboard";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  getRandomPort,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { isAlive, stopTerminalDaemon } from "./helpers/terminal-daemon";
import { waitFor } from "./helpers/wait-for";

// Terminals live in a detached terminal daemon, so restarting the web server
// must not kill them: the restarted server lists the same shell (same pid),
// replays its screen on attach, and keeps streaming live output.
//
// The markers are computed by the shell (`$((40+2))`) so the echoed command
// line can never satisfy the assertion; only the command's output can.

const TOKEN = "terminal-daemon-restart-token";
const PROJECT = "restartproj";
const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");

interface TerminalEntry {
  terminalId: string;
  workspaceId: string;
  pid: number;
}

async function listTerminals(server: ServerHandle): Promise<TerminalEntry[]> {
  const res = await trpcQuery(server.url, "terminal.list", { workspaceId: WORKSPACE_ID }, TOKEN);
  expect(res.status).toBe(200);
  return (await trpcData<{ terminals: TerminalEntry[] }>(res)).terminals;
}

/**
 * A `/terminal` WebSocket that sends `attach`, then collects everything the
 * terminal prints: the replayed snapshot first, then live output.
 */
class TerminalSocket {
  output = "";
  attached = false;
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.output += data.toString("utf8");
        return;
      }
      const frame = JSON.parse(data.toString()) as { type: string };
      if (frame.type === "attached") this.attached = true;
    });
  }

  static async open(server: ServerHandle, terminalId: string): Promise<TerminalSocket> {
    const url = new URL(server.url);
    const ws = new WebSocket(
      `ws://${url.host}/terminal?workspaceId=${encodeURIComponent(WORKSPACE_ID)}&terminalId=${terminalId}`,
      { headers: { Cookie: `band_token=${TOKEN}` } },
    );
    const socket = new TerminalSocket(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "attach", cols: 100, rows: 30 }));
    await waitFor(async () => (socket.attached ? true : undefined), { label: "attach ack" });
    return socket;
  }

  type(input: string): void {
    this.ws.send(input);
  }

  async waitForOutput(text: string): Promise<void> {
    await waitFor(async () => (this.output.includes(text) ? true : undefined), {
      label: `terminal output ${text}`,
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

describe("terminal daemon — shells survive a server restart", () => {
  let tmpHome: string;
  let port: number;
  let server: ServerHandle;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-td-restart-");
    const worktree = join(tmpHome, PROJECT);
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
    port = await getRandomPort();
    server = await startServer({ tmpHome, port });
  });

  afterAll(async () => {
    await server?.close();
    // Belt and braces for a test that failed between the restart's two halves.
    await stopTerminalDaemon(tmpHome);
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("reattaches the same shell with its screen intact, then kills it for good", async () => {
    const terminalId = randomUUID();
    const createRes = await trpcMutate(
      server.url,
      "terminal.create",
      { workspaceId: WORKSPACE_ID, id: terminalId },
      TOKEN,
    );
    expect(createRes.status).toBe(200);
    const created = await trpcData<{ terminalId: string; pid: number }>(createRes);
    expect(created.terminalId).toBe(terminalId);

    const before = await TerminalSocket.open(server, terminalId);
    before.type("echo MARKER_ONE_$((40+2))\r");
    await before.waitForOutput("MARKER_ONE_42");
    await before.close();

    // Restart on the same home and port, leaving the daemon running.
    await server.close({ keepTerminalDaemon: true });
    server = await startServer({ tmpHome, port });

    // Same shell: listed with the pid it was created with.
    expect(await listTerminals(server)).toEqual([
      expect.objectContaining({ terminalId, workspaceId: WORKSPACE_ID, pid: created.pid }),
    ]);

    // Its screen is replayed on attach, and it still runs commands.
    const after = await TerminalSocket.open(server, terminalId);
    await after.waitForOutput("MARKER_ONE_42");
    after.type("echo MARKER_TWO_$((40+3))\r");
    await after.waitForOutput("MARKER_TWO_43");
    await after.close();

    // Killing it through the restarted server ends the shell for good.
    const killRes = await trpcMutate(server.url, "terminal.kill", { terminalId }, TOKEN);
    expect(killRes.status).toBe(200);
    expect(await listTerminals(server)).toEqual([]);
    await waitFor(async () => (isAlive(created.pid) ? undefined : true), { label: "shell exit" });
  });

  it("rejects a /terminal WebSocket without the band_token cookie", async () => {
    const url = new URL(server.url);
    const ws = new WebSocket(
      `ws://${url.host}/terminal?workspaceId=${encodeURIComponent(WORKSPACE_ID)}&terminalId=${randomUUID()}`,
    );
    const opened = await new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("error", () => resolve(false));
      ws.once("unexpected-response", () => resolve(false));
    });
    ws.terminate();
    expect(opened).toBe(false);
  });
});
