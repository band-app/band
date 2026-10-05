import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { stopTerminalDaemon } from "./helpers/terminal-daemon";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

// Cold restore: a terminal reopened after its daemon died or was restarted
// shows its last screen and starts in its saved working directory (see
// `infra/terminals/terminal-history.ts`). `terminal.restartDaemon` is used
// here to end the daemon deterministically — its own shutdown path still
// writes one last checkpoint per session before the process exits, the same
// on-disk shape a periodic checkpoint during a genuine crash would leave.

const TOKEN = "terminal-cold-restore-token";
const REPO = "coldrestoreproj";
const WORKTREE_ID = toWorktreeId(REPO, "main");

interface TerminalEntry {
  terminalId: string;
  worktreeId: string;
  pid: number;
}

describe("terminal cold restore", () => {
  let tmpHome: string;
  let worktree: string;
  let server: ServerHandle | undefined;

  beforeEach(() => {
    tmpHome = createTmpHome("band-td-cold-");
    worktree = `${tmpHome}/${REPO}`;
    mkdirSync(`${worktree}/subdir`, { recursive: true });
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

  async function createTerminal(opts: {
    id: string;
    cwd?: string;
    command?: string;
    env?: Record<string, string>;
  }): Promise<TerminalEntry> {
    if (!server) throw new Error("no server");
    const res = await trpcMutate(
      server.url,
      "terminal.create",
      {
        worktreeId: WORKTREE_ID,
        id: opts.id,
        cwd: opts.cwd,
        command: opts.command,
        env: opts.env,
      },
      TOKEN,
    );
    expect(res.status).toBe(200);
    return trpcData<TerminalEntry>(res);
  }

  it("restores scrollback and cwd when a terminal is reopened after the daemon restarts", async () => {
    server = await startServer({ remoteHost: false, tmpHome });
    const terminalId = randomUUID();
    const created = await createTerminal({ id: terminalId, cwd: "subdir" });

    const socket = await TerminalSocket.open(server, {
      worktreeId: WORKTREE_ID,
      terminalId,
      token: TOKEN,
    });
    socket.type("echo COLD_RESTORE_MARKER_$((10+2))\r");
    await socket.waitForOutput("COLD_RESTORE_MARKER_12");
    await socket.close();

    const restartRes = await trpcMutate(server.url, "terminal.restartDaemon", undefined, TOKEN);
    expect(restartRes.status).toBe(200);
    expect(await trpcData<{ killedCount: number }>(restartRes)).toEqual({ killedCount: 1 });

    // Reopen the same terminalId with no explicit cwd, the way a real
    // reconnect does — the saved cwd from the checkpoint should apply.
    const reopened = await createTerminal({ id: terminalId });
    expect(reopened.pid).not.toBe(created.pid);

    const reopenedSocket = await TerminalSocket.open(server, {
      worktreeId: WORKTREE_ID,
      terminalId,
      token: TOKEN,
    });
    try {
      // The restored scrollback is part of the very first snapshot the fresh
      // shell's session sends — no separate "loading history" round trip.
      await reopenedSocket.waitForOutput("COLD_RESTORE_MARKER_12");
      await reopenedSocket.waitForOutput("session restored");
      reopenedSocket.type("pwd\r");
      await reopenedSocket.waitForOutput(`${worktree}/subdir`);
    } finally {
      await reopenedSocket.close();
    }
  });

  it("relaunches a resumable Claude Code session after the daemon restarts", async () => {
    server = await startServer({ remoteHost: false, tmpHome });
    const terminalId = randomUUID();
    const claudeCwd = `${worktree}/subdir`;

    // A fake Claude Code session transcript for this cwd — Claude Code's own
    // convention: one file per session under
    // ~/.claude/projects/<cwd with "/" -> "-">/<uuid>.jsonl. `homedir()`
    // inside the daemon resolves to `tmpHome`, same as the server.
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const claudeProjectDir = join(tmpHome, ".claude", "projects", claudeCwd.replaceAll("/", "-"));
    mkdirSync(claudeProjectDir, { recursive: true });
    writeFileSync(join(claudeProjectDir, `${sessionId}.jsonl`), "");

    // A stub `claude` binary ahead of the real PATH, so the resume command
    // is observable without the real Claude Code CLI installed.
    const stubDir = `${tmpHome}/stub-bin`;
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "claude"), '#!/bin/sh\necho "CLAUDE_STUB $*"\n', { mode: 0o755 });
    const stubEnv = { PATH: `${stubDir}:${process.env.PATH}` };

    await createTerminal({ id: terminalId, cwd: "subdir", command: "claude", env: stubEnv });
    const socket = await TerminalSocket.open(server, {
      worktreeId: WORKTREE_ID,
      terminalId,
      token: TOKEN,
    });
    // The first-ever spawn runs the plain command as given — no checkpoint
    // exists yet to resume from.
    await socket.waitForOutput("CLAUDE_STUB");
    await socket.close();

    const restartRes = await trpcMutate(server.url, "terminal.restartDaemon", undefined, TOKEN);
    expect(restartRes.status).toBe(200);

    // Reopen with no explicit command, the way a real reconnect does — the
    // saved `sessionCommand` ("claude") plus the seeded transcript should
    // resolve to a resume command instead of a plain re-run.
    await createTerminal({ id: terminalId, env: stubEnv });
    const reopenedSocket = await TerminalSocket.open(server, {
      worktreeId: WORKTREE_ID,
      terminalId,
      token: TOKEN,
    });
    try {
      await reopenedSocket.waitForOutput(`CLAUDE_STUB --resume ${sessionId}`);
    } finally {
      await reopenedSocket.close();
    }
  });

  it("does not restore scrollback for a terminalId that was explicitly killed", async () => {
    server = await startServer({ remoteHost: false, tmpHome });
    const terminalId = randomUUID();
    await createTerminal({ id: terminalId });

    const socket = await TerminalSocket.open(server, {
      worktreeId: WORKTREE_ID,
      terminalId,
      token: TOKEN,
    });
    socket.type("echo SHOULD_NOT_BE_RESTORED_MARKER\r");
    await socket.waitForOutput("SHOULD_NOT_BE_RESTORED_MARKER");
    await socket.close();

    const killRes = await trpcMutate(server.url, "terminal.kill", { terminalId }, TOKEN);
    expect(killRes.status).toBe(200);

    // `kill` prunes the on-disk checkpoint asynchronously (the daemon's own
    // PTY-exit event, not the kill response, triggers it) — wait for it
    // rather than assuming same-tick ordering before checking it's gone.
    const checkpointPath = join(
      tmpHome,
      ".band",
      "terminal-history",
      encodeURIComponent(terminalId),
      "checkpoint.json",
    );
    await waitFor(async () => (existsSync(checkpointPath) ? undefined : true), {
      label: "killed terminal's checkpoint removed",
    });

    // A fresh session under the same id (e.g. the id happened to be reused)
    // must not see the killed tab's old scrollback.
    await createTerminal({ id: terminalId });
    const reopenedSocket = await TerminalSocket.open(server, {
      worktreeId: WORKTREE_ID,
      terminalId,
      token: TOKEN,
    });
    try {
      reopenedSocket.type("echo FRESH_SESSION_MARKER\r");
      await reopenedSocket.waitForOutput("FRESH_SESSION_MARKER");
      expect(reopenedSocket.output).not.toContain("SHOULD_NOT_BE_RESTORED_MARKER");
    } finally {
      await reopenedSocket.close();
    }
  });
});
