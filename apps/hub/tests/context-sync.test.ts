// Integration tests for worker sync of context repos and the redaction scan (plan step 5.2).
// A real hub (the production bundle, auth on, temp BAND_HOME) and two real `band-worker`
// processes with their own HOME. Agents are the scripted ACP stub, which writes the context
// files the way a real agent would. The hub's own worktree covers the local host. Everything
// is read back from the hub's bare repos and the workers' disks.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
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
import { openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
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
const GITHUB_TOKEN = `ghp_${"aB3dE5gH7jK9mN1pQ3sT5vX7zA9cD1fG3hJ5"}`;
const VAULT_SECRET = "vault-held-secret-value-8841";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface Worker {
  name: string;
  hostId: string;
  root: string;
  bandHome: string;
  child: ChildProcess;
}

let hubHome: string;
let hubRepo: string;
let server: ServerHandle;
let a: Worker;
let b: Worker;

const m = async <T>(proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};

const bareRepo = (name: string) => join(hubHome, ".band", "context", `${name}.git`);
const onHub = (name: string, path: string) => git(bareRepo(name), "show", `main:${path}`);
const hubFiles = (name: string) =>
  git(bareRepo(name), "ls-tree", "-r", "--name-only", "main").split("\n").filter(Boolean);

/** Pushes `files` to a context the way a person with the admin token would. */
function adminPush(name: string, files: Record<string, string>): void {
  const dir = tmp(`band-ctx-admin-${name}-`);
  const url = `${server.url}/git/context/${name}.git`;
  const auth = ["-c", `http.extraHeader=Authorization: Bearer ${TEST_TOKEN}`];
  git(dir, ...auth, "clone", "-q", url, "c");
  const clone = join(dir, "c");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(clone, path, ".."), { recursive: true });
    writeFileSync(join(clone, path), content);
  }
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "admin edit");
  git(clone, ...auth, "push", "-q", "origin", "HEAD:main");
}

function scenarioFor(turns: object[]) {
  return { turns };
}

async function addWorker(name: string, labels: string[], turns: (home: string) => object[]) {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: name,
    labels,
  });
  const home = tmp(`band-ctx-${name}-home-`);
  const root = tmp(`band-ctx-${name}-root-`);
  const repo = join(root, "proj");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const bandHome = join(home, ".band");
  writeFileSync(join(home, "scenario.json"), JSON.stringify(scenarioFor(turns(bandHome))));
  const child = spawn(
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
      tmp(`band-ctx-${name}-state-`),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        BAND_HOME: bandHome,
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(home, "acp-state"),
        BAND_TEST_ACP_SCENARIO: join(home, "scenario.json"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: `${name} online`, timeoutMs: 20_000 },
  );
  const worker: Worker = { name, hostId: issued.hostId, root, bandHome, child };
  await m("worktrees.create", {
    repo: "proj",
    branch: `ctx-${name}`,
    hostId: issued.hostId,
    hostRepoPath: repo,
  });
  return worker;
}

let chats = 0;
/** Sends one message the way the browser does and waits for the turn to end. */
async function startTurn(worktreeId: string, text: string) {
  const chatId = `ctx-chat-${++chats}`;
  const stream = await openStream(server.url, chatId, { until: turnEnded, timeoutMs: 40_000 });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  return stream.events;
}

const write = (path: string, content: string) => ({ writeFile: { path, content } });

beforeAll(async () => {
  hubHome = createTmpHome("band-ctx-sync-hub-");
  scratch.push(hubHome);
  hubRepo = join(tmp("band-ctx-sync-hubrepo-"), "proj");
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    repos: [
      {
        name: "proj",
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  const hubUser = join(hubHome, ".band", "context", "user");
  const hubScenario = join(hubHome, "hub-scenario.json");
  writeFileSync(
    hubScenario,
    JSON.stringify(
      scenarioFor([
        {
          match: "^local-note",
          steps: [write(join(hubUser, "local.md"), "from the hub host\n"), { say: "ok" }],
        },
      ]),
    ),
  );
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(hubHome, "acp-state"),
      BAND_TEST_ACP_SCENARIO: hubScenario,
    },
  });

  await m("context.create", { name: "user" });
  await m("context.create", {
    name: "epic",
    kind: "project",
    repos: ["proj"],
    labels: ["org=epic"],
  });
  await m("vault.put", { name: "CONTEXT_TEST_KEY", value: VAULT_SECRET, scope: "global" });

  a = await addWorker("a", [], (home) => [
    {
      match: "^s1",
      steps: [write(join(home, "context/user/notes-from-a.md"), "written by a\n"), { say: "ok" }],
    },
    {
      match: "^s3",
      steps: [
        write(join(home, "context/user/learnings/leak.md"), `token is ${GITHUB_TOKEN}\n`),
        write(join(home, "context/user/vault.md"), `key=${VAULT_SECRET}\n`),
        write(join(home, "context/user/fine.md"), "nothing secret here\n"),
        { say: "ok" },
      ],
    },
    { match: ".*", steps: [{ say: "ok" }] },
  ]);
  b = await addWorker("b", ["org=epic"], (home) => [
    {
      match: "^s2",
      steps: [
        { sleep: 2500 },
        write(join(home, "context/user/shared.md"), "B version\n"),
        write(join(home, "context/user/learnings/log.md"), "base\nB line\n"),
        { say: "ok" },
      ],
    },
    { match: ".*", steps: [{ say: "ok" }] },
  ]);
}, 240_000);

afterAll(async () => {
  a?.child.kill("SIGKILL");
  b?.child.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("context sync", () => {
  it("S1: a session starts on the latest context and its writes reach the hub", async () => {
    adminPush("user", { "preferences.md": "# Preferences\nlatest from the hub\n" });
    await startTurn("proj-ctx-a", "s1 write a note");
    const copy = join(a.bandHome, "context", "user");
    // The pull ran before the agent: the worker's copy has the hub's newest file.
    expect(readFileSync(join(copy, "preferences.md"), "utf8")).toContain("latest from the hub");
    await waitFor(async () => (hubFiles("user").includes("notes-from-a.md") ? true : undefined), {
      label: "agent file on the hub",
      timeoutMs: 20_000,
    });
    expect(onHub("user", "notes-from-a.md")).toBe("written by a\n");
    const log = git(bareRepo("user"), "log", "--format=%s", "main");
    expect(log).toMatch(/agent ctx-chat-\d+ turn 1/);
    // Outside every worktree: nothing landed in the worktree's checkout.
    expect(existsSync(join(a.root, ".band-worktrees", "proj", "ctx-a", "notes-from-a.md"))).toBe(
      false,
    );
  });

  it("S1: the hub's own worktree syncs through the same path", async () => {
    await startTurn("proj-main", "local-note please");
    await waitFor(async () => (hubFiles("user").includes("local.md") ? true : undefined), {
      label: "local host file on the hub",
      timeoutMs: 20_000,
    });
    expect(onHub("user", "local.md")).toBe("from the hub host\n");
  });

  it("S2: a conflict keeps both versions and the hub records it, appends merge", async () => {
    adminPush("user", { "shared.md": "base\n", "learnings/log.md": "base\n" });
    const turn = startTurn("proj-ctx-b", "s2 write while the hub moves");
    // B pulled the base versions and its agent is waiting. The hub moves on before the agent writes.
    await waitFor(
      async () => (existsSync(join(b.bandHome, "context", "user", "shared.md")) ? true : undefined),
      { label: "worker b pulled", timeoutMs: 20_000 },
    );
    adminPush("user", { "shared.md": "hub version\n", "learnings/log.md": "base\nhub line\n" });
    await turn;
    await waitFor(
      async () =>
        hubFiles("user").some((f) => f.startsWith("shared.md.conflict-")) ? true : undefined,
      {
        label: "conflict copy on the hub",
        timeoutMs: 20_000,
      },
    );
    const files = hubFiles("user");
    const kept = files.find((f) => f.startsWith("shared.md.conflict-")) ?? "";
    expect(kept).toMatch(/^shared\.md\.conflict-[\w-]+-\d{8}T\d{6}Z$/);
    expect(onHub("user", kept)).toBe("B version\n");
    expect(onHub("user", "shared.md")).toBe("hub version\n");
    const log = onHub("user", "learnings/log.md");
    expect(log).toContain("hub line");
    expect(log).toContain("B line");
    expect(files.some((f) => f.startsWith("learnings/log.md.conflict-"))).toBe(false);

    type ConflictEvents = {
      events: Array<{
        kind: string;
        hostId: string;
        detail: { conflicts: Array<{ path: string }> };
      }>;
    };
    // The hub records the event when the push call returns, a moment after the files arrive.
    const events = await waitFor(
      async () => {
        const res = await q<ConflictEvents>("context.events", { name: "user" });
        return res.events.some((e) => e.kind === "conflict") ? res.events : undefined;
      },
      { label: "conflict event", timeoutMs: 20_000 },
    );
    const conflict = events.find((e) => e.kind === "conflict");
    expect(conflict?.hostId).toBe(b.hostId);
    expect(conflict?.detail.conflicts.map((c) => c.path)).toEqual(["shared.md"]);
  });

  it("S3: a token pattern and a vault secret are not pushed and are reported", async () => {
    await startTurn("proj-ctx-a", "s3 leak things");
    await waitFor(async () => (hubFiles("user").includes("fine.md") ? true : undefined), {
      label: "clean file pushed",
      timeoutMs: 20_000,
    });
    expect(onHub("user", "fine.md")).toBe("nothing secret here\n");
    expect(hubFiles("user")).not.toContain("learnings/leak.md");
    expect(hubFiles("user")).not.toContain("vault.md");
    for (const name of ["user", "epic"]) {
      const everything = git(bareRepo(name), "log", "-p", "--all");
      expect(everything).not.toContain(GITHUB_TOKEN);
      expect(everything).not.toContain(VAULT_SECRET);
    }

    await waitFor(
      async () => {
        const { events } = await q<{ events: Array<{ kind: string }> }>("context.events", {});
        return events.some((e) => e.kind === "blocked") ? true : undefined;
      },
      { label: "blocked events", timeoutMs: 20_000 },
    );
    const { events } = await q<{
      events: Array<{
        kind: string;
        context: string;
        detail: { findings: Array<{ path: string; rule: string }>; quarantine: string };
      }>;
    }>("context.events", {});
    const blocked = events.filter((e) => e.kind === "blocked");
    const rules = blocked.flatMap((e) => e.detail.findings.map((f) => `${f.path}:${f.rule}`));
    expect(rules).toContain("learnings/leak.md:github-token");
    expect(rules).toContain("vault.md:vault-secret");
    // The report names rules and lines, never the matched text.
    expect(JSON.stringify(events)).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(events)).not.toContain(VAULT_SECRET);

    // The held-back files sit in a quarantine on the worker, and are gone from the working copy.
    const quarantine = blocked[0]?.detail.quarantine ?? "";
    expect(quarantine.startsWith(join(a.bandHome, "context-quarantine"))).toBe(true);
    expect(existsSync(join(a.bandHome, "context", "user", "learnings", "leak.md"))).toBe(false);
    const held = readdirSync(join(a.bandHome, "context-quarantine"), { recursive: true });
    expect(held.some((f) => String(f).endsWith("leak.md"))).toBe(true);
  });

  it("S4: a host whose labels do not allow a project context never receives it", async () => {
    // Worker A has no labels. The repo's project context needs org=epic, so A never gets it.
    await startTurn("proj-ctx-a", "plain message");
    expect(existsSync(join(a.bandHome, "context", "projects", "epic"))).toBe(false);
    expect(existsSync(join(a.bandHome, "context", "projects"))).toBe(false);
    // Worker B carries the label and gets it.
    await startTurn("proj-ctx-b", "plain message");
    expect(existsSync(join(b.bandHome, "context", "projects", "epic"))).toBe(true);
  });
});
