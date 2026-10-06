// Integration test for a project folder on a worker (plan step T.1). The coordinator is pinned to a real
// `band-worker` process, so the folder, the checkouts, the repo tools and the agent's cwd all go through the link
// and the worker's path policy. The agent is the scripted ACP stub on the worker. The worker shares the machine with
// the hub, so the test reads the worker's disk directly to check what the host built.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeLines, STUB_AGENT_PATH, type StubRequest, TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
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
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" }).trim();

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

let home: string;
let server: ServerHandle;
let workerChild: ChildProcess;
let workerHostId: string;
let workerRoot: string;
let workerHome: string;
let workerStubLog: string;
let projectId: string;
let chatId: string;

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

const workerRequests = (method: string): StubRequest[] =>
  existsSync(workerStubLog)
    ? completeLines(readFileSync(workerStubLog, "utf8"))
        .map((l) => JSON.parse(l) as StubRequest)
        .filter((r) => r.method === method)
    : [];

const remoteOf = (name: string) => join(workerRoot, "remotes", `${name}.git`);
const cloneOf = (name: string) => join(workerRoot, name);

function seedRemoteRepo(name: string): void {
  git(workerRoot, "init", "-q", "--bare", "-b", "main", remoteOf(name));
  git(workerRoot, "clone", "-q", remoteOf(name), cloneOf(name));
  git(cloneOf(name), "checkout", "-q", "-B", "main");
  writeFileSync(join(cloneOf(name), "README.md"), `${name} on the worker\n`);
  git(cloneOf(name), "add", ".");
  git(cloneOf(name), "commit", "-q", "-m", "init");
  git(cloneOf(name), "push", "-q", "-u", "origin", "main");
}

beforeAll(async () => {
  home = createTmpHome("band-folder-remote-");
  // The hub's own repo rows. Only the worker's clones are used, since the coordinator is pinned there.
  const repos = ["api", "client"].map((name) => {
    const path = join(home, "repos", name);
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    writeFileSync(join(path, "README.md"), `${name}\n`);
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", "init");
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  });
  seedState(home, { repos });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: { BAND_SERVE_UI: "false", BAND_PROJECT_FETCH_THROTTLE_MS: "0" },
  });

  workerRoot = tmp("band-folder-root-");
  for (const name of ["api", "client"]) seedRemoteRepo(name);
  workerHome = tmp("band-folder-whome-");
  workerStubLog = join(workerHome, "stub-log.jsonl");
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "Project box",
  });
  workerHostId = issued.hostId;
  workerChild = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      workerRoot,
      "--state-dir",
      tmp("band-folder-state-"),
    ],
    {
      env: {
        ...process.env,
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
        // The worker runs the fetches, so it needs the setting the hub test sets for itself.
        BAND_PROJECT_FETCH_THROTTLE_MS: "0",
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(workerHome, "acp-state"),
        BAND_TEST_ACP_LOG: workerStubLog,
      },
      stdio: "ignore",
    },
  );
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === workerHostId)?.status === "online" ? true : undefined;
    },
    { label: "worker online", timeoutMs: 20_000 },
  );
  // The first use of a repo on a host records its clone there.
  for (const name of ["api", "client"]) {
    await m("worktrees.create", {
      repo: name,
      branch: `seed-${name}`,
      hostId: workerHostId,
      hostRepoPath: cloneOf(name),
    });
  }
  const created = await m<{ project: { id: string; coordinator: { chatId: string } } }>(
    "projects.create",
    {
      name: "shop",
      repos: [{ repo: "api" }, { repo: "client" }],
      coordinatorHostId: workerHostId,
    },
  );
  projectId = created.project.id;
  chatId = created.project.coordinator.chatId;
}, 180_000);

afterAll(async () => {
  workerChild?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  if (home) removeTmpHome(home);
});

describe("the coordinator on a worker", () => {
  let session: StubRequest;
  let folder: string;

  it("runs the agent on the worker in the project folder, which holds the checkouts", async () => {
    folder = join(workerHome, ".band", "projects", "shop");
    session = await waitFor(() => workerRequests("session/new").find((r) => r.cwd === folder), {
      label: "session/new on the worker",
      timeoutMs: 60_000,
    });
    const state = (
      await q<{
        folder: {
          hostId: string;
          folder: string;
          checkouts: Array<{ repo: string; status: string }>;
        };
      }>("projects.folder", { project: "shop" })
    ).folder;
    expect(state.hostId).toBe(workerHostId);
    expect(state.folder).toBe(folder);
    expect(state.checkouts.map((c) => [c.repo, c.status])).toEqual([
      ["api", "current"],
      ["client", "current"],
    ]);
    for (const repo of ["api", "client"]) {
      const dir = join(folder, "repos", repo);
      expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(`${repo} on the worker\n`);
      expect(git(dir, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
    }
    expect(existsSync(join(folder, "notes.md"))).toBe(true);
  });

  it("gives the agent no worktree id, and the project id instead", () => {
    expect(session.env.BAND_WORKTREE_ID).toBeUndefined();
    expect(session.env.BAND_PROJECT_ID).toBe(projectId);
  });

  it("reaches the coordinator tools through the worker's relay and reads the worker's checkout", async () => {
    const servers = session.params.mcpServers as Array<{
      url: string;
      headers: Array<{ name: string; value: string }>;
    }>;
    const headers = Object.fromEntries(servers[0].headers.map((h) => [h.name, h.value]));
    expect(servers[0].url).not.toContain(server.url);
    expect(headers["X-Band-Relay-Token"]).toBeTruthy();
    const client = new Client({ name: "folder-remote", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(servers[0].url), { requestInit: { headers } }),
    );
    try {
      const res = (await client.callTool({
        name: "repo_read",
        arguments: { repo: "api", path: "README.md" },
      })) as { content: Array<{ text: string }> };
      expect(res.content.map((c) => c.text).join("")).toContain("api on the worker");
      const other = (await client.callTool({
        name: "repo_read",
        arguments: { repo: "api", path: "../client/README.md" },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(other.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("lets a project chat call the MCP proxy only, and nothing else on the hub", async () => {
    const servers = session.params.mcpServers as Array<{
      url: string;
      headers: Array<{ name: string; value: string }>;
    }>;
    const relay = new URL(servers[0].url).origin;
    const relayToken = servers[0].headers.find((h) => h.name === "X-Band-Relay-Token")?.value ?? "";
    const trpc = await fetch(`${relay}/trpc/repos.list`, {
      headers: { Authorization: `Bearer ${relayToken}` },
    });
    expect(trpc.status).toBe(403);
    expect(await trpc.text()).toContain("FORBIDDEN");
  });

  it("fast-forwards a clean checkout on the next turn", async () => {
    const other = join(tmp("band-folder-mate-"), "api");
    git(workerRoot, "clone", "-q", remoteOf("api"), other);
    writeFileSync(join(other, "news.md"), "news\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "news");
    git(other, "push", "-q", "origin", "main");

    const before = workerRequests("session/prompt").length;
    await m("chats.send", { worktreeId: `project:${projectId}`, chatId, message: "anything new?" });
    await waitFor(() => (workerRequests("session/prompt").length > before ? true : undefined), {
      label: "turn on the worker",
      timeoutMs: 30_000,
    });
    expect(readFileSync(join(folder, "repos", "api", "news.md"), "utf8")).toBe("news\n");
  });

  it("clones a repo registered by URL only, through repos.ensure, and checks it out", async () => {
    // A repo with a remote URL and no checkout anywhere: the worker clones it into its repos dir.
    git(workerRoot, "init", "-q", "--bare", "-b", "main", remoteOf("docs"));
    const seed = join(tmp("band-folder-seed-"), "docs");
    git(workerRoot, "clone", "-q", remoteOf("docs"), seed);
    git(seed, "checkout", "-q", "-B", "main");
    writeFileSync(join(seed, "README.md"), "docs by url\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "init");
    git(seed, "push", "-q", "-u", "origin", "main");
    await m("repos.addByUrl", { remoteUrl: remoteOf("docs"), defaultBranch: "main", name: "docs" });
    await m("projects.addRepo", { project: "shop", repo: "docs" });

    const checkout = await waitFor(
      async () => {
        const f = (
          await q<{ folder: { checkouts: Array<{ repo: string; status: string }> } | null }>(
            "projects.folder",
            { project: "shop" },
          )
        ).folder;
        return f?.checkouts.find((c) => c.repo === "docs");
      },
      { label: "docs checkout", timeoutMs: 30_000 },
    );
    expect(checkout.status).toBe("current");
    expect(readFileSync(join(folder, "repos", "docs", "README.md"), "utf8")).toBe("docs by url\n");
    // The clone is the worker's own, under its default repos directory, not a path the hub chose.
    const clone = git(join(folder, "repos", "docs"), "rev-parse", "--git-common-dir");
    expect(clone).toContain(join(workerHome, "band", "repos"));
  });
});
