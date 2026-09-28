import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";
import { StatusStream } from "./helpers/status-stream";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

// A held key must echo at the key-repeat rate while the branch-status poller
// runs. The poller used to start git for every workspace at once; each
// `child_process` spawn blocks the server's event loop for a few ms, so with
// dozens of workspaces the loop froze for 300-800 ms every 5 s tick and the
// echo arrived in bursts (`services/_utils/map-limited.ts`). Spawns cost the
// most on macOS, where this reproduced; a Linux host may stay under the limit
// even without the fix.

const TOKEN = "terminal-echo-branch-poll-token";
const PROJECT = "echoproj";
const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
/** Enough workspaces that one tick's git spawns block the loop for ~300 ms+. */
const EXTRA_WORKSPACES = 72;
/** macOS key auto-repeat is ~30 keys/s. */
const REPEAT_MS = 33;
/** Longer than two 5 s poll ticks, so the hold overlaps at least one. */
const HOLD_MS = 11_000;
/** Slowest acceptable echo. A tick's burst of spawns took 300-800 ms. */
const MAX_ECHO_MS = 150;
/**
 * Keys allowed over `MAX_ECHO_MS`, for a stray GC pause or a busy CI host. A
 * blocked loop delays every key sent during the block, 10+ at 30 keys/s.
 */
const SLOW_ECHOES_ALLOWED = 2;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv, stdio: "ignore" });
}

describe("terminal echo while the branch-status poller runs", () => {
  let tmpHome: string;
  let server: ServerHandle;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-echo-branch-poll-");
    // Keep zsh from running its new-user wizard in the temp home.
    writeFileSync(join(tmpHome, ".zshrc"), "PROMPT='$ '\n");
    const repo = join(tmpHome, PROJECT);
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# echo\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
    const worktrees = [{ branch: "main", path: repo }];
    for (let i = 0; i < EXTRA_WORKSPACES; i++) {
      const path = join(tmpHome, `${PROJECT}-w${i}`);
      git(repo, ["worktree", "add", "-q", "-b", `w${i}`, path]);
      worktrees.push({ branch: `w${i}`, path });
    }
    seedState(tmpHome, {
      projects: [{ name: PROJECT, path: repo, defaultBranch: "main", worktrees }],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("refuses terminal.create without the token", async () => {
    const res = await fetch(`${server.url}/trpc/terminal.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, id: randomUUID() }),
    });
    expect(res.status).toBe(401);
  });

  it("echoes a held key within 150 ms", { timeout: 60_000 }, async () => {
    const terminalId = randomUUID();
    const res = await trpcMutate(
      server.url,
      "terminal.create",
      { workspaceId: WORKSPACE_ID, id: terminalId },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const socket = await TerminalSocket.open(server, {
      workspaceId: WORKSPACE_ID,
      terminalId,
      token: TOKEN,
      flow: true,
    });
    socket.onOutput((text) => socket.ack(Buffer.byteLength(text)));
    let status: StatusStream | undefined;
    const echoes: number[] = [];
    const sent: number[] = [];
    try {
      // `cat` in canonical mode: the tty echoes each key exactly once.
      socket.type("echo READY-$((20+22)); cat\r");
      await socket.waitForOutput("READY-42", 20_000);
      // The dashboard's status stream is what keeps the poller running. Hold
      // the key once its first tick has reached every workspace.
      const stream = await StatusStream.open(server.url, TOKEN);
      status = stream;
      await waitFor(async () => stream.branchStatuses.size > EXTRA_WORKSPACES || undefined, {
        timeoutMs: 20_000,
        label: "first poll tick",
      });

      const stopCounting = socket.onOutput((text) => {
        const at = performance.now();
        for (const char of text) if (char === "a") echoes.push(at);
      });
      const start = performance.now();
      while (performance.now() - start < HOLD_MS) {
        sent.push(performance.now());
        socket.type("a");
        const next = start + sent.length * REPEAT_MS;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - performance.now())));
      }
      await waitFor(async () => echoes.length >= sent.length || undefined, {
        label: "every held key echoed",
      });
      // What the shell prints after the Ctrl-C isn't an echo: with `SHELL`
      // set to bash, which ignores `.zshrc`, its prompt `bash-3.2$ ` has an "a".
      stopCounting();
      socket.type("\x03");
    } finally {
      status?.close();
      await socket.close();
    }

    expect(echoes).toHaveLength(sent.length);
    const slow = sent.map((at, i) => Math.round(echoes[i] - at)).filter((ms) => ms >= MAX_ECHO_MS);
    expect(slow.length, `echoes over ${MAX_ECHO_MS} ms: ${slow.join(", ")}`).toBeLessThanOrEqual(
      SLOW_ECHOES_ALLOWED,
    );
  });
});
