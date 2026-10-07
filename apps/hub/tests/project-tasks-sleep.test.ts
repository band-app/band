// Integration test for sleep and wake of a task on an ephemeral worker (plan steps T.2 and 3.5). A real hub (the
// production bundle, temp BAND_HOME) runs the bundled `local` runner hook, which starts the real
// `band-worker --ephemeral`. The task is made on that worker with two repos, an edit in each member and a conversation
// in the task's chat. The worker idles out and exits, the "machine" is wiped, and a message to the chat wakes it. Every
// member worktree is back in the new task folder with its edit, and the chat resumes the session it had.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maxId, openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const IDLE_MS = 2500;

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

/** A bare origin and the hub's checkout of it, with one commit on main. */
function makeRepo(base: string, name: string): { origin: string; checkout: string } {
  const origin = join(base, `${name}-origin.git`);
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare", "-b", "main");
  const checkout = join(base, name);
  git(base, "clone", "-q", origin, checkout);
  git(checkout, "checkout", "-q", "-b", "main");
  writeFileSync(join(checkout, "hello.txt"), "hello\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "init");
  git(checkout, "push", "-q", "origin", "main");
  return { origin, checkout };
}

let server: ServerHandle;
let hubHome: string;
let stubState: string;
let stubLog: string;

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

interface TaskView {
  id: string;
  hostId: string | null;
  folder: string | null;
  chatIds: string[];
  members: Array<{ repo: string; worktreeId: string | null; path: string | null }>;
}
interface Worktree {
  name: string;
  path: string;
  hostId?: string;
  lifecycle?: "sleeping" | "waking";
}

const findWorktree = async (repo: string, name: string) =>
  (await q<{ repos: Array<{ name: string; worktrees: Worktree[] }> }>("repos.list")).repos
    .find((p) => p.name === repo)
    ?.worktrees.find((w) => w.name === name);

const stubRequests = (method: string) =>
  existsSync(stubLog)
    ? readFileSync(stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method: string; params: { sessionId?: string } })
        .filter((r) => r.method === method)
    : [];

async function turn(scope: string, chatId: string, text: string, after = 0) {
  const stream = await openStream(server.url, chatId, {
    lastEventId: after,
    until: (e) => turnEnded(e) && (e.eventId > after || e.eventId < 0),
    timeoutMs: 120_000,
  });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId: scope, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  return stream.events;
}

beforeAll(async () => {
  hubHome = createTmpHome("band-task-sleep-hub-");
  scratch.push(hubHome);
  const base = tmp("band-task-sleep-repos-");
  const a = makeRepo(base, "proja");
  const b = makeRepo(base, "projb");
  stubState = tmp("band-task-sleep-stub-state-");
  stubLog = join(tmp("band-task-sleep-stub-log-"), "stub-log.jsonl");
  const scenario = join(tmp("band-task-sleep-scenario-"), "scenario.json");
  writeFileSync(scenario, JSON.stringify({ turns: [{ steps: [{ say: "ok" }] }] }));
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    repos: [a, b].map((p, i) => ({
      name: i === 0 ? "proja" : "projb",
      path: p.checkout,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: p.checkout }],
    })),
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_EPHEMERAL_IDLE_TIMEOUT_MS: String(IDLE_MS),
      BAND_AGENT_IDLE_TIMEOUT_MS: "1500",
    },
  });
  await m("settings.update", {
    runners: [
      {
        id: "eph",
        spawn: "bundled:local",
        destroy: "bundled:local",
        labels: { pool: "eph" },
        isolation: "process",
        maxConcurrent: 2,
        timeoutSec: 90,
        env: {
          BAND_WORKER_BIN: WORKER_BIN,
          BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
          BAND_TEST_ACP_STATE: stubState,
          BAND_TEST_ACP_LOG: stubLog,
          BAND_TEST_ACP_SCENARIO: scenario,
          BAND_AGENT_SESSION_DIRS: stubState,
        },
      },
    ],
  });
  await m("projects.create", {
    name: "sleepy",
    repos: [{ repo: "proja" }, { repo: "projb" }],
    policy: { autonomy: "autonomous" },
  });
}, 120_000);

afterAll(async () => {
  const runners = join(hubHome ?? "", ".band", "runners", "eph");
  if (existsSync(runners)) {
    for (const dir of readdirSync(runners)) {
      try {
        process.kill(Number(readFileSync(join(runners, dir, "pid"), "utf8").trim()), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("sleep and wake of a task (S6)", () => {
  let task: TaskView;
  let hostId = "";
  let chatId = "";
  let sessionFile = "";
  let seen = 0;

  it("stores every member worktree and the task chat when the ephemeral worker idles out", async () => {
    // A worktree started through placement is what makes the ephemeral worker. The task goes on that host.
    await m("worktrees.create", {
      repo: "proja",
      branch: "eph-seed",
      placement: { labels: { pool: "eph" } },
    });
    hostId = (
      await waitFor(
        async () => {
          const wt = await findWorktree("proja", "eph-seed");
          return wt?.hostId ? wt : undefined;
        },
        { label: "ephemeral worker up", timeoutMs: 90_000, intervalMs: 250 },
      )
    ).hostId as string;

    ({ task } = await m<{ task: TaskView }>("projectTasks.create", {
      project: "sleepy",
      branch: "feat-sleep",
      repos: [{ repo: "proja" }, { repo: "projb" }],
      brief: "Sleep and wake.\n",
      hostId,
      // The test sends the first message itself, so it knows which events belong to which turn.
      start: false,
    }));
    expect(task.hostId).toBe(hostId);
    for (const member of task.members) {
      appendFileSync(join(member.path as string, "hello.txt"), `edit in ${member.repo}\n`);
    }
    chatId = task.chatIds[0] as string;
    const first = await turn(`task:${task.id}`, chatId, "remember: banana");
    seen = maxId(first);
    const sessions = readdirSync(stubState).filter((f) => f.endsWith(".json"));
    expect(sessions.length).toBeGreaterThan(0);
    sessionFile = sessions[0] as string;

    await waitFor(
      async () =>
        (await findWorktree("proja", "feat-sleep"))?.lifecycle === "sleeping" &&
        (await findWorktree("projb", "feat-sleep"))?.lifecycle === "sleeping"
          ? true
          : undefined,
      { label: "both members sleep", timeoutMs: 90_000, intervalMs: 250 },
    );
    // The hub kept the brief and the chat's agent session.
    expect(existsSync(join(hubHome, ".band", "sleep", `task-${task.id}`, "BRIEF.md"))).toBe(true);
    expect(existsSync(join(hubHome, ".band", "sleep", `task-${task.id}`, "sessions.json"))).toBe(
      true,
    );
  }, 240_000);

  it("wakes on a message to the task chat with every member and the conversation back", async () => {
    // The old machine is gone: only what the hub saved can bring the work back.
    for (const f of readdirSync(stubState)) rmSync(join(stubState, f), { recursive: true });
    const sessionsStarted = stubRequests("session/new").length;

    const events = await turn(`task:${task.id}`, chatId, "what was it?", seen);
    expect(events.some((e) => e.type === "turn-ended")).toBe(true);

    const { task: woken } = await q<{ task: TaskView }>("projectTasks.get", { task: task.id });
    expect(woken.hostId).toBe(hostId);
    expect(woken.members.map((x) => x.repo)).toEqual(["proja", "projb"]);
    const folder = woken.folder as string;
    expect(readFileSync(join(folder, "BRIEF.md"), "utf8")).toContain("Sleep and wake.");
    for (const member of woken.members) {
      // Back in the task folder, on the task's branch, with the edit uncommitted again.
      expect(member.path).toBe(join(folder, member.repo));
      const file = readFileSync(join(member.path as string, "hello.txt"), "utf8");
      expect(file).toBe(`hello\nedit in ${member.repo}\n`);
      expect(git(member.path as string, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
        "feat-sleep",
      );
      expect(git(member.path as string, "status", "--porcelain")).toMatch(/^ M hello\.txt$/m);
    }
    expect((await findWorktree("proja", "feat-sleep"))?.lifecycle).toBeUndefined();

    // The agent resumed the session it had, and did not start a new one.
    const resumed = [...stubRequests("session/resume"), ...stubRequests("session/load")];
    expect(resumed.map((r) => r.params.sessionId)).toContain(sessionFile.replace(/\.json$/, ""));
    expect(stubRequests("session/new")).toHaveLength(sessionsStarted);
    expect(existsSync(join(hubHome, ".band", "sleep", `task-${task.id}`))).toBe(false);
  }, 240_000);
});
