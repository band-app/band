// V1 and V2 of the projects redesign, hub side. A project's folder opens as a worktree with the id
// `project:<id>`, so the worktree file procedures, terminals and chats work on it. Its files sync in
// the background to every host doing the project's work, with no push or pull call. A real hub
// (production bundle, random port, auth on, a short BAND_CONTEXT_AUTOSYNC_MS), a real `band-worker`
// that holds a worktree of the project, real git with a local bare remote, and the scripted ACP
// stub agent on both. The worker shares the machine with the hub, so the test reads and writes the
// worker's copy of the project folder on disk, as an agent on the worker would.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeLines, STUB_AGENT_PATH, TEST_TOKEN } from "./helpers/acp-chat";
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
let coordinatorChatId: string;

const m = async <T>(proc: string, input: unknown, token = TEST_TOKEN) => {
  const res = await trpcMutate(server.url, proc, input, token);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};

const scope = () => `project:${projectId}`;
const hubFolder = () => join(realpathSync(home), ".band", "projects", "shop");
const workerFolder = () => join(workerHome, ".band", "projects", "shop");
const hubBareRepo = () => join(home, ".band", "context", "shop.git");

/** A file at the head of the hub's bare context repo, or undefined while it is not there. */
const hubHeadFile = (path: string): string | undefined => {
  try {
    return execFileSync("git", ["--git-dir", hubBareRepo(), "show", `HEAD:${path}`], {
      encoding: "utf8",
      env: gitEnv,
      stdio: "pipe",
    });
  } catch {
    return undefined;
  }
};

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

const listFiles = (path = "") =>
  q<{ entries: Array<{ name: string; type: string }> }>("worktree.listFiles", {
    worktreeId: scope(),
    path,
  });

beforeAll(async () => {
  home = createTmpHome("band-folder-view-");
  // One repo with a bare origin. The hub and the worker each clone it.
  const remote = join(home, "remotes", "api.git");
  mkdirSync(join(home, "remotes"), { recursive: true });
  git(home, "init", "-q", "--bare", "-b", "main", remote);
  const hubClone = join(home, "repos", "api");
  git(home, "clone", "-q", remote, hubClone);
  git(hubClone, "checkout", "-q", "-B", "main");
  writeFileSync(join(hubClone, "README.md"), "api\n");
  git(hubClone, "add", ".");
  git(hubClone, "commit", "-q", "-m", "init");
  git(hubClone, "push", "-q", "-u", "origin", "main");
  seedState(home, {
    repos: [
      {
        name: "api",
        path: hubClone,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubClone }],
      },
    ],
  });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_CONTEXT_AUTOSYNC_MS: "500",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
    },
  });

  workerRoot = tmp("band-folder-view-root-");
  git(workerRoot, "clone", "-q", remote, "api");
  workerHome = tmp("band-folder-view-whome-");
  workerStubLog = join(workerHome, "stub-log.jsonl");
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "Dev box",
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
      tmp("band-folder-view-state-"),
    ],
    {
      env: {
        ...process.env,
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
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

  // The coordinator runs on the hub's own host. The worker does project work in a worktree.
  const created = await m<{ project: { id: string; coordinator: { chatId: string } } }>(
    "projects.create",
    { name: "shop", repos: [{ repo: "api" }] },
  );
  projectId = created.project.id;
  coordinatorChatId = created.project.coordinator.chatId;
  await m("worktrees.create", {
    repo: "api",
    branch: "feat-remote",
    hostId: workerHostId,
    hostRepoPath: join(workerRoot, "api"),
    projectId,
  });
}, 180_000);

afterAll(async () => {
  workerChild?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  if (home) removeTmpHome(home);
});

describe("the project folder opens as a worktree (V1)", () => {
  it("prepares the folder for any device token, and only an admin's call makes checkouts", async () => {
    const viewer = (await m<{ token: string }>("tokens.createDevice", { label: "viewer" })).token;
    // A viewer gets the folder and its context, and the state once something else prepared it.
    await m("projects.prepareFolder", { project: "shop" }, viewer);
    expect(existsSync(join(hubFolder(), "notes.md"))).toBe(true);
    const { folder } = await m<{ folder: { folder: string; checkouts: Array<{ repo: string }> } }>(
      "projects.prepareFolder",
      { project: "shop" },
    );
    expect(realpathSync(folder.folder)).toBe(hubFolder());
    expect(folder.checkouts.map((c) => c.repo)).toEqual(["api"]);
  });

  it("lists and reads the project's files through the worktree file procedures", async () => {
    const { entries } = await listFiles();
    const names = entries.map((e) => e.name);
    expect(names).toContain("notes.md");
    expect(names).toContain("docs");
    expect(names).toContain("repos");
    // The folder's own git checkout is no business of the view.
    expect(names).not.toContain(".git");
    const notes = await q<{ content: string }>("worktree.getFile", {
      worktreeId: scope(),
      path: "notes.md",
    });
    expect(notes.content).toContain("# Notes");
  });

  it("keeps every file call away from git data and refuses git writes on the folder", async () => {
    const refused = async (kind: "query" | "mutate", proc: string, input: object) => {
      const body = { worktreeId: scope(), ...input };
      const res =
        kind === "query"
          ? await trpcQuery(server.url, proc, body, TEST_TOKEN)
          : await trpcMutate(server.url, proc, body, TEST_TOKEN);
      expect(res.status, `${proc} ${JSON.stringify(input)}`).not.toBe(200);
    };
    const configBefore = readFileSync(join(hubFolder(), ".git", "config"), "utf8");
    // The copy's own `.git`, any spelling, and a checkout's `.git` pointer under repos/.
    await refused("query", "worktree.listFiles", { path: ".git" });
    await refused("query", "worktree.getFile", { path: "repos/api/.git" });
    await refused("mutate", "worktree.saveFile", { path: ".GIT/config", content: "[core]\n" });
    await refused("mutate", "worktree.saveFile", {
      path: "repos/api/.git",
      content: "gitdir: x\n",
    });
    await refused("mutate", "worktree.createFile", { path: "docs/.git/config", content: "x" });
    expect(readFileSync(join(hubFolder(), ".git", "config"), "utf8")).toBe(configBefore);
    expect(statSync(join(hubFolder(), "repos", "api", ".git")).isDirectory()).toBe(true);
    const checkout = await listFiles("repos/api");
    expect(checkout.entries.map((e) => e.name)).toContain("README.md");
    expect(checkout.entries.map((e) => e.name)).not.toContain(".git");
    // Changes go out through the context sync, never a git call on the folder.
    await refused("mutate", "worktree.gitCommit", { message: "by hand" });
    await refused("mutate", "worktree.gitPush", {});
    await refused("mutate", "worktree.stageFiles", { paths: ["notes.md"] });
  });

  it("opens a terminal in the project folder", async () => {
    const created = await m<{ terminalId: string; worktreeId: string }>("terminal.create", {
      worktreeId: scope(),
    });
    expect(created.worktreeId).toBe(scope());
    const out = join(home, "view-terminal-pwd.txt");
    await m("terminal.send", { terminalId: created.terminalId, data: `pwd > ${out}\n` });
    const written = await waitFor(() => readIfExists(out)?.trim() || undefined, {
      label: "pwd output",
      timeoutMs: 30_000,
    });
    expect(realpathSync(written)).toBe(hubFolder());
  });

  it("makes a project chat beside the coordinator, and refuses to remove the coordinator", async () => {
    const { chat } = await m<{ chat: { id: string } }>("chats.create", {
      worktreeId: scope(),
      name: "side",
    });
    const { chats } = await q<{ chats: Array<{ id: string }> }>("chats.list", {
      worktreeId: scope(),
    });
    expect(chats.map((c) => c.id).sort()).toEqual([coordinatorChatId, chat.id].sort());

    const refused = await trpcMutate(
      server.url,
      "chats.remove",
      { chatId: coordinatorChatId },
      TEST_TOKEN,
    );
    expect(refused.status).toBe(400);
    await m("chats.remove", { chatId: chat.id });
    const after = await q<{ chats: Array<{ id: string }> }>("chats.list", { worktreeId: scope() });
    expect(after.chats.map((c) => c.id)).toEqual([coordinatorChatId]);
  });

  it("is not listed as a repo", async () => {
    const { repos } = await q<{ repos: Array<{ name: string }> }>("repos.list");
    expect(repos.map((r) => r.name)).toEqual(["api"]);
  });
});

describe("the project's files sync on their own (V2)", () => {
  it("brings a file saved in the project view to the hub's context repo and the worker's copy", async () => {
    await m("worktree.createFile", {
      worktreeId: scope(),
      path: "docs/from-hub.md",
      content: "written in the project view\n",
    });
    const atHub = await waitFor(() => hubHeadFile("docs/from-hub.md"), {
      label: "file in the hub's context repo",
      timeoutMs: 30_000,
    });
    expect(atHub).toBe("written in the project view\n");
    const onWorker = await waitFor(() => readIfExists(join(workerFolder(), "docs/from-hub.md")), {
      label: "file in the worker's project folder",
      timeoutMs: 30_000,
    });
    expect(onWorker).toBe("written in the project view\n");
  });

  it("brings a file written in the worker's copy to the project view", async () => {
    await waitFor(() => (existsSync(join(workerFolder(), "notes.md")) ? true : undefined), {
      label: "worker copy of the project folder",
      timeoutMs: 30_000,
    });
    mkdirSync(join(workerFolder(), "inbox"), { recursive: true });
    writeFileSync(join(workerFolder(), "inbox", "from-worker.md"), "an agent on the worker\n");
    const atHub = await waitFor(() => hubHeadFile("inbox/from-worker.md"), {
      label: "worker file in the hub's context repo",
      timeoutMs: 30_000,
    });
    expect(atHub).toBe("an agent on the worker\n");
    const inView = await waitFor(
      async () => {
        const res = await trpcQuery(
          server.url,
          "worktree.getFile",
          { worktreeId: scope(), path: "inbox/from-worker.md" },
          TEST_TOKEN,
        );
        if (res.status !== 200) return undefined;
        return (await trpcData<{ content: string }>(res)).content;
      },
      { label: "worker file in the project view", timeoutMs: 30_000 },
    );
    expect(inView).toBe("an agent on the worker\n");
  });

  it("gives a worktree agent of the project its project folder on its host", async () => {
    const { chat } = await m<{ chat: { id: string } }>("chats.create", {
      worktreeId: "api-feat-remote",
      name: "worker",
    });
    await m("chats.send", { worktreeId: "api-feat-remote", chatId: chat.id, message: "hello" });
    const started = await waitFor(
      () =>
        existsSync(workerStubLog)
          ? completeLines(readFileSync(workerStubLog, "utf8"))
              .map(
                (l) =>
                  JSON.parse(l) as {
                    method: string;
                    params: { cwd?: string; additionalDirectories?: string[] };
                  },
              )
              .find((r) => r.method === "session/new" && r.params.cwd?.endsWith("/feat-remote"))
          : undefined,
      { label: "session/new of the worktree agent", timeoutMs: 30_000 },
    );
    expect(started.params.additionalDirectories).toContain(workerFolder());
  });

  it("answers 401 to the file procedures without a token", async () => {
    const res = await trpcQuery(server.url, "worktree.listFiles", { worktreeId: scope() }, "");
    expect(res.status).toBe(401);
  });
});
