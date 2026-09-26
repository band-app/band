import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

// A terminal printing as fast as its PTY allows must not cost the server its
// connection to the terminal daemon. All of a server's terminals share one
// stream socket from the daemon; the daemon used to write to it without
// backpressure and drop the server once 64 MB were unread, which a
// full-speed flood reached within seconds. Every terminal on that server
// then looked exited. The daemon now pauses a flooding PTY while the stream
// is backed up, so the flood completes, and a quiet terminal keeps echoing
// meanwhile.

const TOKEN = "terminal-daemon-flood-token";
const PROJECT = "floodproj";
const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
/** Well past the daemon's 64 MB drop threshold. */
const FLOOD_BYTES = 200_000_000;

let tmpHome: string;
let server: ServerHandle;

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

beforeAll(async () => {
  tmpHome = createTmpHome("band-td-flood-");
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
  server = await startServer({ tmpHome });
});

afterAll(async () => {
  await server?.close();
  rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("terminal daemon under a full-speed flood", () => {
  it("delivers the whole flood and keeps a quiet terminal echoing", {
    timeout: 120_000,
  }, async () => {
    const floodId = await createTerminal();
    const quietId = await createTerminal();
    const flood = await TerminalSocket.open(server, {
      workspaceId: WORKSPACE_ID,
      terminalId: floodId,
      token: TOKEN,
      maxOutputChars: 64 * 1024,
    });
    const quiet = await TerminalSocket.open(server, {
      workspaceId: WORKSPACE_ID,
      terminalId: quietId,
      token: TOKEN,
    });
    quiet.type("echo QUIET_READY_$((40+2))\r");
    await quiet.waitForOutput("QUIET_READY_42");

    // Markers are computed by the shell so the echoed command can't match.
    flood.type(
      `perl -e '$|=1; my $l = "\\e[32m" . ("x" x 150) . "\\e[0m\\n"; print $l for 1..${Math.ceil(FLOOD_BYTES / 160)}'; echo FLOOD_DONE_$((40+2))\r`,
    );
    // Mid-flood, the quiet terminal still answers, and promptly. The bound is
    // loose for loaded CI runners; a backed-up stream delays echo by seconds.
    await waitFor(async () => flood.bytes >= 20_000_000 || undefined, {
      timeoutMs: 30_000,
      label: "flood under way",
    });
    const typedAt = Date.now();
    quiet.type("echo QUIET_DURING_$((40+3))\r");
    await quiet.waitForOutput("QUIET_DURING_43", 30_000);
    expect(Date.now() - typedAt).toBeLessThan(5_000);

    await flood.waitForOutput("FLOOD_DONE_42", 90_000);
    expect(flood.bytes).toBeGreaterThan(FLOOD_BYTES);

    // Both terminals are still live on the server.
    const res = await trpcQuery(server.url, "terminal.list", { workspaceId: WORKSPACE_ID }, TOKEN);
    expect(res.status).toBe(200);
    const { terminals } = await trpcData<{ terminals: { terminalId: string }[] }>(res);
    expect(terminals.map((t) => t.terminalId).sort()).toEqual([floodId, quietId].sort());

    await flood.close();
    await quiet.close();
  });

  it("refuses to list terminals without the token", async () => {
    const input = encodeURIComponent(JSON.stringify({ workspaceId: WORKSPACE_ID }));
    const res = await fetch(`${server.url}/trpc/terminal.list?input=${input}`);
    expect(res.status).toBe(401);
  });
});
