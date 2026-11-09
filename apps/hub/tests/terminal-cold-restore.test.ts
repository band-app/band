import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectSlug } from "@band-app/shared/claude-session";
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
import { testWorktreeId } from "./helpers/test-host";
import { waitFor } from "./helpers/wait-for";

// Cold restore: a terminal reopened after its daemon died or was restarted
// shows its last screen and starts in its saved working directory (see
// `infra/terminals/terminal-history.ts`). `terminal.restartDaemon` is used
// here to end the daemon deterministically — its own shutdown path still
// writes one last checkpoint per session before the process exits, the same
// on-disk shape a periodic checkpoint during a genuine crash would leave.

const TOKEN = "terminal-cold-restore-token";
const REPO = "coldrestoreproj";
const WORKTREE_ID = testWorktreeId(REPO, "main", false);

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
    // ~/.claude/projects/<slug of cwd>/<uuid>.jsonl. `homedir()`
    // inside the daemon resolves to `tmpHome`, same as the server.
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const claudeProjectDir = join(tmpHome, ".claude", "projects", claudeProjectSlug(claudeCwd));
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

  // Restoring an agent. The stub `claude` appends its argv to a file, so each
  // test reads exactly what the restore ran.
  describe("agent resume", () => {
    const OLD_SESSION = "aaaaaaaa-2222-3333-4444-555555555555";
    const NEW_SESSION = "bbbbbbbb-2222-3333-4444-555555555555";

    function stubClaude(): { stubDir: string; log: string; env: Record<string, string> } {
      const stubDir = `${tmpHome}/stub-bin`;
      const log = `${tmpHome}/claude-argv.log`;
      mkdirSync(stubDir, { recursive: true });
      writeFileSync(join(stubDir, "claude"), '#!/bin/sh\necho "$*" >> "$STUB_LOG"\n', {
        mode: 0o755,
      });
      return { stubDir, log, env: { PATH: `${stubDir}:${process.env.PATH}`, STUB_LOG: log } };
    }

    function seedTranscript(sessionId: string, ageSeconds: number): void {
      const dir = join(tmpHome, ".claude", "projects", claudeProjectSlug(`${worktree}/subdir`));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${sessionId}.jsonl`);
      writeFileSync(file, "");
      const at = new Date(Date.now() - ageSeconds * 1000);
      utimesSync(file, at, at);
    }

    const argvLines = (log: string) =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((l, i, a) => l || i < a.length - 1)
        : [];

    async function reportHook(terminalId: string, sessionId: string, event: string) {
      if (!server) throw new Error("no server");
      const res = await trpcMutate(
        server.url,
        "statuses.notify",
        {
          cwd: `${worktree}/subdir`,
          agent: "claude-code",
          terminalId,
          payload: {
            session_id: sessionId,
            transcript_path: join(tmpHome, ".claude", "projects", "x", `${sessionId}.jsonl`),
            cwd: `${worktree}/subdir`,
            hook_event_name: event,
          },
        },
        TOKEN,
      );
      expect(res.status).toBe(200);
    }

    async function restartAndReopen(terminalId: string, env: Record<string, string>) {
      if (!server) throw new Error("no server");
      const restartRes = await trpcMutate(server.url, "terminal.restartDaemon", undefined, TOKEN);
      expect(restartRes.status).toBe(200);
      await createTerminal({ id: terminalId, env });
      const socket = await TerminalSocket.open(server, {
        worktreeId: WORKTREE_ID,
        terminalId,
        token: TOKEN,
      });
      try {
        await socket.waitForOutput("session restored");
      } finally {
        await socket.close();
      }
    }

    it("resumes the session id the hooks reported, past a newer transcript and without the launch prompt", async () => {
      server = await startServer({ remoteHost: false, tmpHome });
      const { log, env } = stubClaude();
      seedTranscript(OLD_SESSION, 600);
      seedTranscript(NEW_SESSION, 0);
      const terminalId = randomUUID();
      await createTerminal({
        id: terminalId,
        cwd: "subdir",
        command: "claude 'ORIGINAL_PROMPT'",
        env,
      });
      await waitFor(async () => (argvLines(log).length === 1 ? true : undefined), {
        label: "first run of the stub",
      });
      await reportHook(terminalId, OLD_SESSION, "UserPromptSubmit");

      await restartAndReopen(terminalId, env);
      await waitFor(async () => (argvLines(log).length === 2 ? true : undefined), {
        label: "restore ran the stub",
      });
      expect(argvLines(log)).toEqual(["ORIGINAL_PROMPT", `--resume ${OLD_SESSION}`]);
    });

    it("resumes an agent typed by hand in the shell", async () => {
      server = await startServer({ remoteHost: false, tmpHome });
      const { log, env } = stubClaude();
      seedTranscript(NEW_SESSION, 0);
      const terminalId = randomUUID();
      await createTerminal({ id: terminalId, cwd: "subdir", env });
      const socket = await TerminalSocket.open(server, {
        worktreeId: WORKTREE_ID,
        terminalId,
        token: TOKEN,
      });
      socket.type("claude\r");
      await waitFor(async () => (argvLines(log).length === 1 ? true : undefined), {
        label: "hand-typed stub ran",
      });
      await socket.close();
      await reportHook(terminalId, OLD_SESSION, "UserPromptSubmit");

      await restartAndReopen(terminalId, env);
      await waitFor(async () => (argvLines(log).length === 2 ? true : undefined), {
        label: "restore ran the stub",
      });
      expect(argvLines(log)).toEqual(["", `--resume ${OLD_SESSION}`]);
    });

    it("resumes the newest transcript, without the prompt, when the command is an absolute path and no id is known", async () => {
      server = await startServer({ remoteHost: false, tmpHome });
      const { stubDir, log, env } = stubClaude();
      seedTranscript(OLD_SESSION, 600);
      seedTranscript(NEW_SESSION, 0);
      const terminalId = randomUUID();
      await createTerminal({
        id: terminalId,
        cwd: "subdir",
        command: `${stubDir}/claude 'ORIGINAL_PROMPT'`,
        env,
      });
      await waitFor(async () => (argvLines(log).length === 1 ? true : undefined), {
        label: "first run of the stub",
      });

      await restartAndReopen(terminalId, env);
      await waitFor(async () => (argvLines(log).length === 2 ? true : undefined), {
        label: "restore ran the stub",
      });
      expect(argvLines(log)).toEqual(["ORIGINAL_PROMPT", `--resume ${NEW_SESSION}`]);
    });

    it("does not resume an agent that sent SessionEnd", async () => {
      server = await startServer({ remoteHost: false, tmpHome });
      const { log, env } = stubClaude();
      seedTranscript(OLD_SESSION, 0);
      const terminalId = randomUUID();
      await createTerminal({ id: terminalId, cwd: "subdir", command: "claude", env });
      await waitFor(async () => (argvLines(log).length === 1 ? true : undefined), {
        label: "first run of the stub",
      });
      await reportHook(terminalId, OLD_SESSION, "UserPromptSubmit");
      await reportHook(terminalId, OLD_SESSION, "SessionEnd");

      await restartAndReopen(terminalId, env);
      // The shell runs input in order, so once it echoes a marker typed now,
      // any resume command the restore wrote earlier has already run.
      const socket = await TerminalSocket.open(server, {
        worktreeId: WORKTREE_ID,
        terminalId,
        token: TOKEN,
      });
      try {
        socket.type("echo AFTER_RESTORE_$((40+2))\r");
        await socket.waitForOutput("AFTER_RESTORE_42");
      } finally {
        await socket.close();
      }
      expect(argvLines(log)).toEqual([""]);
    });
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
