import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
} from "./helpers/server";
import {
  isAlive,
  parentPid,
  startDaemonOfBuild,
  stopTerminalDaemon,
} from "./helpers/terminal-daemon";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

// `terminal.restartDaemon` (Settings > Terminal / `band terminals
// restart-daemon`) SIGTERMs the current-build terminal daemon so its shells
// end and a fresh one starts the next spawn. It must only ever touch the
// current-build daemon — a daemon of another build already draining after
// being superseded (see the build-mismatch tests, issue #652) keeps its
// shells running untouched throughout.

const TOKEN = "terminal-restart-daemon-token";
const REPO = "restartproj";
const WORKTREE_ID = toWorktreeId(REPO, "main");
const DAEMON_ENTRY = resolve(import.meta.dirname, "../dist/terminal-daemon.mjs");

interface TerminalEntry {
  terminalId: string;
  worktreeId: string;
  pid: number;
}

describe("terminal.restartDaemon", () => {
  let tmpHome: string;
  let worktree: string;
  let server: ServerHandle | undefined;

  beforeEach(() => {
    tmpHome = createTmpHome("band-td-restart-");
    worktree = `${tmpHome}/${REPO}`;
    mkdirSync(worktree, { recursive: true });
    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: worktree,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: worktree }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await stopTerminalDaemon(tmpHome);
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function createTerminal(id: string = randomUUID()): Promise<TerminalEntry> {
    if (!server) throw new Error("no server");
    const res = await trpcMutate(
      server.url,
      "terminal.create",
      { worktreeId: WORKTREE_ID, id },
      TOKEN,
    );
    expect(res.status).toBe(200);
    return trpcData<TerminalEntry>(res);
  }

  it("ends every terminal on the current daemon and leaves a retired daemon's shells running", async () => {
    // A daemon of another build already serves the endpoint; the server's
    // first spawn below supersedes it (issue #652), leaving it retired.
    const old = await startDaemonOfBuild(tmpHome, { entry: DAEMON_ENTRY, buildId: "old-build" });
    const oldTerminalId = randomUUID();
    const oldShellPid = await old.spawnShell({
      worktreeId: WORKTREE_ID,
      terminalId: oldTerminalId,
      worktreeRoot: worktree,
    });

    server = await startServer({ remoteHost: false, tmpHome });

    const a = await createTerminal();
    const b = await createTerminal();
    const currentDaemonPid = parentPid(a.pid);
    expect(parentPid(b.pid)).toBe(currentDaemonPid);
    expect(currentDaemonPid).not.toBe(old.pid);

    const socketA = await TerminalSocket.open(server, {
      worktreeId: WORKTREE_ID,
      terminalId: a.terminalId,
      token: TOKEN,
    });
    const socketB = await TerminalSocket.open(server, {
      worktreeId: WORKTREE_ID,
      terminalId: b.terminalId,
      token: TOKEN,
    });

    const res = await trpcMutate(server.url, "terminal.restartDaemon", undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(await trpcData<{ killedCount: number }>(res)).toEqual({ killedCount: 2 });

    // Both panes see their PTY exit — same close code a normal PTY exit uses
    // (`ws.ts`), so the client shows "Process completed" and doesn't reconnect.
    expect(await socketA.waitForClose()).toBe(1000);
    expect(await socketB.waitForClose()).toBe(1000);
    await waitFor(async () => (isAlive(currentDaemonPid) ? undefined : true), {
      label: "restarted daemon exit",
    });

    // The retired daemon and its shell were never signaled.
    expect(isAlive(old.pid)).toBe(true);
    expect(isAlive(oldShellPid)).toBe(true);

    // Reopening a terminalId that lived on the restarted daemon spawns a
    // fresh shell on a fresh daemon, not the one just ended.
    const reopened = await createTerminal(a.terminalId);
    expect(reopened.pid).not.toBe(a.pid);
    expect(parentPid(reopened.pid)).not.toBe(currentDaemonPid);
  });

  it("is a no-op when no terminal has ever been spawned", async () => {
    server = await startServer({ remoteHost: false, tmpHome });
    const res = await trpcMutate(server.url, "terminal.restartDaemon", undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(await trpcData<{ killedCount: number }>(res)).toEqual({ killedCount: 0 });
  });

  it("requires the auth token, like the other terminal procedures", async () => {
    server = await startServer({ remoteHost: false, tmpHome });
    const res = await fetch(`${server.url}/trpc/terminal.restartDaemon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
