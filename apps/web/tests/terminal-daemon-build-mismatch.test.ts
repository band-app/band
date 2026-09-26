import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import {
  isAlive,
  parentPid,
  startDaemonOfBuild,
  stopTerminalDaemon,
  terminalDaemons,
} from "./helpers/terminal-daemon";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

// Issue #652: a terminal daemon outlives the build that launched it, so a
// server can find one running another build's code (an auto-update), or code
// that is no longer on disk (a deleted dev worktree). The server must not
// start new shells there. It starts a daemon of its own build for them, and
// the old daemon drains: its shells stay reachable, and it exits with the last.
//
// The markers are computed by the shell (`$((40+2))`) so the echoed command
// line can never satisfy the assertion; only the command's output can.

const TOKEN = "terminal-daemon-build-token";
const PROJECT = "buildproj";
const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
const DAEMON_ENTRY = resolve(import.meta.dirname, "../dist/terminal-daemon.mjs");

interface TerminalEntry {
  terminalId: string;
  workspaceId: string;
  pid: number;
}

describe("terminal daemon — a daemon from another build", () => {
  let tmpHome: string;
  let worktree: string;
  let server: ServerHandle | undefined;
  /** Deleted after each test: a daemon entry copied so it can be removed. */
  let entryCopyDir: string | undefined;

  beforeEach(() => {
    tmpHome = createTmpHome("band-td-build-");
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
  });

  afterEach(async () => {
    // Stops every daemon on the home, the superseded one included.
    await server?.close();
    server = undefined;
    // A test that failed before booting its server still left the old daemon.
    await stopTerminalDaemon(tmpHome);
    if (entryCopyDir) rmSync(entryCopyDir, { recursive: true, force: true });
    entryCopyDir = undefined;
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function listTerminals(): Promise<TerminalEntry[]> {
    if (!server) throw new Error("no server");
    const res = await trpcQuery(server.url, "terminal.list", { workspaceId: WORKSPACE_ID }, TOKEN);
    expect(res.status).toBe(200);
    return (await trpcData<{ terminals: TerminalEntry[] }>(res)).terminals;
  }

  async function createTerminal(id: string = randomUUID()): Promise<TerminalEntry> {
    if (!server) throw new Error("no server");
    const res = await trpcMutate(
      server.url,
      "terminal.create",
      { workspaceId: WORKSPACE_ID, id },
      TOKEN,
    );
    expect(res.status).toBe(200);
    return trpcData<TerminalEntry>(res);
  }

  async function killTerminal(terminalId: string): Promise<void> {
    if (!server) throw new Error("no server");
    const res = await trpcMutate(server.url, "terminal.kill", { terminalId }, TOKEN);
    expect(res.status).toBe(200);
  }

  async function expectShellResponds(terminalId: string, marker: string): Promise<void> {
    if (!server) throw new Error("no server");
    const socket = await TerminalSocket.open(server, {
      workspaceId: WORKSPACE_ID,
      terminalId,
      token: TOKEN,
    });
    socket.type(`echo ${marker}_$((40+2))\r`);
    await socket.waitForOutput(`${marker}_42`);
    await socket.close();
  }

  /**
   * This home's retired names: the token and pid record in the run dir, and
   * the socket beside the endpoint, which may be a directory other homes share.
   */
  function retiredFiles(): string[] {
    const runDir = join(tmpHome, ".band", "run");
    const inRunDir = readdirSync(runDir).filter((name) => name.includes(".retired-"));
    const socketDir = dirname(
      JSON.parse(readFileSync(join(runDir, "terminal-daemon-v1.pid"), "utf8")).socket,
    );
    const sockets = inRunDir
      .map((name) => /\.retired-([0-9a-f]+)\.token$/.exec(name)?.[1])
      .filter((tag) => tag !== undefined)
      .map((tag) => `.r${tag}`);
    return [...inRunDir, ...sockets.filter((name) => existsSync(join(socketDir, name)))];
  }

  /** Wait for the new daemon to remove the retired names once the old daemon is gone. */
  async function waitForRetiredNamesRemoved(): Promise<void> {
    await waitFor(async () => (retiredFiles().length === 0 ? true : undefined), {
      label: "retired names removed",
    });
  }

  it("starts new terminals on a daemon of this build, and the old daemon drains", async () => {
    const old = await startDaemonOfBuild(tmpHome, {
      entry: DAEMON_ENTRY,
      buildId: "another-build",
    });
    const oldTerminalId = randomUUID();
    const oldShell = await old.spawnShell({
      workspaceId: WORKSPACE_ID,
      terminalId: oldTerminalId,
      workspaceRoot: worktree,
    });

    const port = await getRandomPort();
    server = await startServer({ tmpHome, port });

    // A new terminal lands on a new daemon, not the old one.
    const created = await createTerminal();
    const newDaemon = parentPid(created.pid);
    expect(newDaemon).not.toBe(old.pid);
    expect(terminalDaemons(tmpHome).map((daemon) => daemon.pid)).toEqual(
      expect.arrayContaining([old.pid, newDaemon]),
    );

    // The old daemon's shell is still listed and still runs commands.
    expect(isAlive(oldShell)).toBe(true);
    expect(await listTerminals()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ terminalId: oldTerminalId, pid: oldShell }),
        expect.objectContaining({ terminalId: created.terminalId, pid: created.pid }),
      ]),
    );
    await expectShellResponds(oldTerminalId, "OLD_BEFORE_RESTART");
    expect(retiredFiles()).toHaveLength(3);

    // Creating a terminal that already lives on the old daemon returns it
    // rather than starting a second shell on the new one (#617).
    const again = await createTerminal(oldTerminalId);
    expect(again.pid).toBe(oldShell);
    expect(parentPid(oldShell)).toBe(old.pid);
    expect((await listTerminals()).filter((t) => t.terminalId === oldTerminalId)).toHaveLength(1);

    // A restarted server reaches it too, though the endpoint is the new daemon's now.
    await server.close({ keepTerminalDaemon: true });
    server = await startServer({ tmpHome, port });
    expect(await listTerminals()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ terminalId: oldTerminalId, pid: oldShell }),
        expect.objectContaining({ terminalId: created.terminalId, pid: created.pid }),
      ]),
    );
    await expectShellResponds(oldTerminalId, "OLD_AFTER_RESTART");

    // Once its last shell ends, the old daemon exits, and the new daemon
    // removes the retired names it made for it. The new shell is untouched.
    await killTerminal(oldTerminalId);
    await waitFor(async () => (isAlive(old.pid) ? undefined : true), { label: "old daemon exit" });
    await waitForRetiredNamesRemoved();
    expect(isAlive(newDaemon)).toBe(true);
    expect(await listTerminals()).toEqual([
      expect.objectContaining({ terminalId: created.terminalId, pid: created.pid }),
    ]);
    await expectShellResponds(created.terminalId, "NEW");

    // Terminals across two daemons still need the token.
    const input = encodeURIComponent(JSON.stringify({ workspaceId: WORKSPACE_ID }));
    const unauthenticated = await fetch(`${server.url}/trpc/terminal.list?input=${input}`);
    expect(unauthenticated.status).toBe(401);
  });

  it("takes no new terminals on a daemon whose entry file is gone, even of this build", async () => {
    // The build ID the server computes for its own daemon entry.
    const { size, mtimeMs } = statSync(DAEMON_ENTRY);
    const buildId = `${size}-${Math.trunc(mtimeMs)}`;
    // A copy inside dist/, so node-pty still resolves from dist/node_modules
    // while the file exists: a worktree that is about to be deleted.
    entryCopyDir = join(resolve(DAEMON_ENTRY, ".."), `.test-${randomUUID()}`);
    mkdirSync(entryCopyDir);
    const entryCopy = join(entryCopyDir, "terminal-daemon.mjs");
    copyFileSync(DAEMON_ENTRY, entryCopy);
    const old = await startDaemonOfBuild(tmpHome, { entry: entryCopy, buildId });
    const oldTerminalId = randomUUID();
    const oldShell = await old.spawnShell({
      workspaceId: WORKSPACE_ID,
      terminalId: oldTerminalId,
      workspaceRoot: worktree,
    });
    rmSync(entryCopyDir, { recursive: true, force: true });

    server = await startServer({ tmpHome });

    const created = await createTerminal();
    const newDaemon = parentPid(created.pid);
    expect(newDaemon).not.toBe(old.pid);
    // Same build as the old daemon, so only the missing entry set them apart.
    expect(terminalDaemons(tmpHome).find((daemon) => daemon.pid === newDaemon)?.buildId).toBe(
      buildId,
    );
    await expectShellResponds(created.terminalId, "NEW");
    await expectShellResponds(oldTerminalId, "OLD");

    await killTerminal(oldTerminalId);
    await waitFor(async () => (isAlive(old.pid) ? undefined : true), { label: "old daemon exit" });
    expect(isAlive(oldShell)).toBe(false);
    await waitForRetiredNamesRemoved();
  });
});
