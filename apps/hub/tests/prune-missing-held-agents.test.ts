// A worktree whose folder was deleted outside Band is pruned even while its chat's agent idles with
// background work (an AIR async task, the same hold a `ScheduleWakeup` leaves). A running turn
// keeps it until the turn ends. A real hub with BAND_LOCAL_WORKER=off, one real `band-worker` and
// the scripted ACP stub agent running on that worker.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openStream,
  STUB_AGENT_PATH,
  stubRequests,
  TEST_TOKEN,
  trpc,
  turnEnded,
} from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { isAlive } from "./helpers/terminal-daemon";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const TOKEN = TEST_TOKEN;
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const SLOW_TURN_MS = 12_000;

interface RepoView {
  name: string;
  worktrees: { worktreeId: string; missing?: boolean }[];
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });

let server: ServerHandle;
let hostId: string;
let worker: ChildProcess;
let root: string;
let workerHome: string;

const mutate = (procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN);
const listProj = async () =>
  (
    await trpcData<{ repos: RepoView[] }>(
      await trpcQuery(server.url, "repos.list", undefined, TOKEN),
    )
  ).repos.find((r) => r.name === "proj");
const find = async (id: string) => (await listProj())?.worktrees.find((w) => w.worktreeId === id);

async function createWorktree(branch: string): Promise<string> {
  const res = await mutate("worktrees.create", {
    repo: "proj",
    branch,
    hostId,
    hostRepoPath: join(root, "proj"),
  });
  expect(res.status).toBe(200);
  return `proj-${branch}@${hostId}`;
}

/** Sends a message in a new chat of the worktree and waits for the turn to end (or not). */
async function startTurn(worktreeId: string, chatId: string, text: string, wait: boolean) {
  const stream = await openStream(server.url, chatId, { until: turnEnded, timeoutMs: 60_000 });
  const res = await fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ worktreeId, text, files: [] }),
  });
  expect(res.ok).toBe(true);
  if (wait) await stream.events;
  return stream.events;
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-prune-held-hub-");
  scratch.push(hubHome);
  seedSettings(hubHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    repos: [{ name: "proj", path: "", defaultBranch: "main", worktrees: [] }],
  });
  server = await startServer({
    tmpHome: hubHome,
    env: { BAND_LOCAL_WORKER: "off", BAND_SERVE_UI: "false" },
    remoteHost: false,
  });

  root = tmp("band-prune-held-root-");
  const state = tmp("band-prune-held-state-");
  workerHome = tmp("band-prune-held-home-");
  const repo = join(root, "proj");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  const scenario = join(workerHome, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      turns: [
        {
          match: "hold",
          steps: [
            {
              asyncTask: {
                asyncTaskId: "task-held",
                name: "watch",
                taskType: "monitor",
                description: "watch",
                showInTranscript: false,
                canStop: true,
              },
            },
            { say: "Holding." },
          ],
        },
        {
          match: "ask",
          steps: [
            {
              permission: {
                toolCall: { toolCallId: "run-1", title: "Run tests", kind: "execute" },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
              },
              after: { allow: [{ say: "Ran." }] },
            },
          ],
        },
        { match: "slow", steps: [{ say: "Working." }, { sleep: SLOW_TURN_MS }, { say: "Done." }] },
      ],
    }),
  );

  const issued = await trpcData<{ token: string; hostId: string }>(
    await trpcMutate(server.url, "tokens.issueWorkerBootstrap", { hostName: "w" }, TOKEN),
  );
  hostId = issued.hostId;
  worker = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      root,
      "--state-dir",
      state,
    ],
    {
      env: {
        ...process.env,
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
        BAND_TERMINAL_DAEMON: "0",
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(workerHome, "acp-state"),
        BAND_TEST_ACP_LOG: join(workerHome, "acp-stub-log.jsonl"),
        BAND_TEST_ACP_SCENARIO: scenario,
      },
      stdio: "ignore",
    },
  );
  await waitFor(
    async () => {
      const res = await trpcData<{ hosts: { id: string; status: string }[] }>(
        await trpcQuery(server.url, "hosts.list", undefined, TOKEN),
      );
      return res.hosts.find((h) => h.id === hostId)?.status === "online" ? true : undefined;
    },
    { label: "worker online", timeoutMs: 20_000 },
  );
}, 180_000);

afterAll(async () => {
  worker?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) removeTmpHome(dir);
});

describe("a worktree whose folder is gone", () => {
  it("is pruned while its agent idles with a background hold, and the agent stops", async () => {
    const id = await createWorktree("held");
    await startTurn(id, "prune-held-chat", "hold", true);
    const [prompt] = stubRequests(workerHome, "session/prompt");
    const pid = prompt.pid;
    expect(isAlive(pid)).toBe(true);

    rmSync(join(root, ".band-worktrees", "proj", "held"), { recursive: true, force: true });
    git(join(root, "proj"), "worktree", "prune");

    await waitFor(async () => ((await find(id)) ? undefined : true), {
      label: "held worktree pruned",
      timeoutMs: 45_000,
      intervalMs: 1_000,
    });
    await expect.poll(() => isAlive(pid), { timeout: 15_000 }).toBe(false);
  }, 120_000);

  it("is kept while a turn runs, and pruned once it ends", async () => {
    const id = await createWorktree("busy");
    const turn = startTurn(id, "prune-busy-chat", "slow", false);
    await waitFor(
      async () => (stubRequests(workerHome, "session/prompt").length > 1 ? true : undefined),
      {
        label: "slow turn started",
        timeoutMs: 20_000,
      },
    );

    rmSync(join(root, ".band-worktrees", "proj", "busy"), { recursive: true, force: true });
    git(join(root, "proj"), "worktree", "prune");

    await waitFor(async () => ((await find(id))?.missing ? true : undefined), {
      label: "busy worktree marked missing",
      timeoutMs: 20_000,
    });
    // Still mid-turn: the row stays.
    expect(await find(id)).toBeDefined();

    await turn;
    await waitFor(async () => ((await find(id)) ? undefined : true), {
      label: "busy worktree pruned after the turn",
      timeoutMs: 45_000,
      intervalMs: 1_000,
    });
  }, 120_000);

  it("is kept while a permission request waits, and pruned once it is answered", async () => {
    const id = await createWorktree("asking");
    const chatId = "prune-asking-chat";
    let requestId: string | undefined;
    const stream = await openStream(server.url, chatId, {
      until: turnEnded,
      timeoutMs: 90_000,
      onEvent: (e) => {
        if (e.type === "permission") requestId = e.requestId;
      },
    });
    const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
      body: JSON.stringify({ worktreeId: id, text: "ask", files: [] }),
    });
    expect(res.ok).toBe(true);
    await waitFor(async () => requestId, { label: "permission requested", timeoutMs: 20_000 });

    rmSync(join(root, ".band-worktrees", "proj", "asking"), { recursive: true, force: true });
    git(join(root, "proj"), "worktree", "prune");
    await waitFor(async () => ((await find(id))?.missing ? true : undefined), {
      label: "asking worktree marked missing",
      timeoutMs: 20_000,
    });
    expect(await find(id)).toBeDefined();

    await trpc(server.url, "chat.answer", { chatId, requestId, optionId: "allow" });
    await stream.events;
    await waitFor(async () => ((await find(id)) ? undefined : true), {
      label: "asking worktree pruned after the answer",
      timeoutMs: 45_000,
      intervalMs: 1_000,
    });
  }, 120_000);

  it("is kept while a terminal is open, and pruned once it is killed", async () => {
    const id = await createWorktree("shelled");
    const { terminalId } = await trpcData<{ terminalId: string }>(
      await mutate("terminal.create", { worktreeId: id }),
    );
    rmSync(join(root, ".band-worktrees", "proj", "shelled"), { recursive: true, force: true });
    git(join(root, "proj"), "worktree", "prune");
    await waitFor(async () => ((await find(id))?.missing ? true : undefined), {
      label: "shelled worktree marked missing",
      timeoutMs: 20_000,
    });
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await find(id)).toBeDefined();

    await mutate("terminal.kill", { terminalId });
    await waitFor(async () => ((await find(id)) ? undefined : true), {
      label: "shelled worktree pruned after the kill",
      timeoutMs: 45_000,
      intervalMs: 1_000,
    });
  }, 120_000);
});
