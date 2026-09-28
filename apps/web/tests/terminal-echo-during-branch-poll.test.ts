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
// echo arrived in bursts (`services/_utils/map-limited.ts`). Later, with the
// spawns on a worker thread, storing and emitting every workspace's status
// each tick still held the loop for 100-300 ms on the macOS CI runner.
//
// A shared CI host also stalls on its own now and then, so the test holds the
// key twice on the same server, first before the poller starts and then while
// it runs, and allows the second hold only a few more slow keys than the first.
// A stall at every tick delays 10+ keys per hold.

const TOKEN = "terminal-echo-branch-poll-token";
const PROJECT = "echoproj";
const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
/** Enough workspaces that one tick's work used to block the loop for ~300 ms+. */
const EXTRA_WORKSPACES = 72;
/** macOS key auto-repeat is ~30 keys/s. */
const REPEAT_MS = 33;
/** Longer than two 5 s poll ticks, so the hold overlaps at least one. */
const HOLD_MS = 11_000;
/** Slowest acceptable echo. A tick's stall took 300-800 ms. */
const MAX_ECHO_MS = 150;
/**
 * Keys over `MAX_ECHO_MS` the poller hold may have beyond the idle hold: one
 * ~250 ms host stall delays about three.
 */
const EXTRA_SLOW_ECHOES_ALLOWED = 3;

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

  it("echoes a held key within 150 ms", { timeout: 90_000 }, async () => {
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

    /** Hold "a" for `HOLD_MS` and return each key's echo delay in ms. */
    const holdKey = async (): Promise<number[]> => {
      const echoes: number[] = [];
      const sent: number[] = [];
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
      expect(echoes).toHaveLength(sent.length);
      const delays = sent.map((at, i) => Math.round(echoes[i] - at));
      // End the line: macOS caps a canonical-mode tty line at 1024 bytes.
      // `cat` prints it back; wait for that too, so the next hold doesn't
      // count its "a"s as echoes.
      socket.type("\r");
      await waitFor(async () => echoes.length >= 2 * sent.length || undefined, {
        label: "held line printed back",
      });
      stopCounting();
      return delays;
    };
    const slowKeys = (delays: number[]) => delays.filter((ms) => ms >= MAX_ECHO_MS);

    let status: StatusStream | undefined;
    let idleSlow: number[];
    let pollerSlow: number[];
    try {
      // `cat` in canonical mode: the tty echoes each key exactly once.
      socket.type("echo READY-$((20+22)); cat\r");
      await socket.waitForOutput("READY-42", 20_000);
      // No status stream has connected yet, so the poller hasn't started. It
      // starts with the first status-stream subscription, so the idle hold has
      // to come before the stream opens.
      idleSlow = slowKeys(await holdKey());
      // The dashboard's status stream is what starts the poller. Hold the key
      // once its first tick has reached every workspace.
      const stream = await StatusStream.open(server.url, TOKEN);
      status = stream;
      await waitFor(async () => stream.branchStatuses.size > EXTRA_WORKSPACES || undefined, {
        timeoutMs: 20_000,
        label: "first poll tick",
      });
      pollerSlow = slowKeys(await holdKey());
      // What the shell prints after the Ctrl-C isn't an echo either: with
      // `SHELL` set to bash, which ignores `.zshrc`, its prompt `bash-3.2$ `
      // has an "a". Nothing counts echoes any more at this point.
      socket.type("\x03");
    } finally {
      status?.close();
      await socket.close();
    }

    expect(
      pollerSlow.length,
      `echoes over ${MAX_ECHO_MS} ms with the poller running: ${pollerSlow.join(", ")}; ` +
        `before it started: ${idleSlow.join(", ")}`,
    ).toBeLessThanOrEqual(idleSlow.length + EXTRA_SLOW_ECHOES_ALLOWED);
  });
});
