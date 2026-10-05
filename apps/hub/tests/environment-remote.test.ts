// Integration tests for `.band/environment.json` on a remote host (plan step
// 3.1): a real `band-worker` process dials a real hub, reports the tool
// versions it has, and a worktree on it runs the file's install and start on
// the worker. `requires` is checked against what the worker reported.

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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const TOKEN = "environment-remote-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

const ENVIRONMENT = {
  install: 'echo REMOTE-INSTALL > "$PWD/installed.txt"',
  start: 'echo REMOTE-START > "$PWD/started.txt"',
  terminals: [{ name: "dev", command: 'echo REMOTE-TERMINAL > "$PWD/terminal.txt"' }],
  requires: { node: ">=99", docker: ">=1" },
};

let server: ServerHandle;
let worker: ChildProcess;
let workerRoot: string;
let hostId: string;

const q = async <T>(procedure: string, input?: unknown): Promise<T> => {
  const res = await trpcQuery(server.url, procedure, input, TOKEN);
  const body = await res.clone().text();
  expect(res.status, body).toBe(200);
  return trpcData<T>(res);
};
const m = async <T>(procedure: string, input: unknown): Promise<T> => {
  const res = await trpcMutate(server.url, procedure, input, TOKEN);
  const body = await res.clone().text();
  expect(res.status, body).toBe(200);
  return trpcData<T>(res);
};

interface HostView {
  id: string;
  status: string;
  tools: Record<string, string>;
}
const hostView = async () =>
  (await q<{ hosts: HostView[] }>("hosts.list")).hosts.find((h) => h.id === hostId);

beforeAll(async () => {
  const hubHome = createTmpHome("band-envremote-hub-");
  scratch.push(hubHome);
  workerRoot = tmp("band-envremote-root-");
  const workerState = tmp("band-envremote-state-");
  const workerHome = tmp("band-envremote-whome-");

  const hubRepo = join(tmp("band-envremote-hubrepo-"), "proj");
  makeRepo(hubRepo);
  mkdirSync(join(hubRepo, ".band"), { recursive: true });
  writeFileSync(join(hubRepo, ".band", "environment.json"), JSON.stringify(ENVIRONMENT));
  const workerRepo = join(workerRoot, "proj");
  makeRepo(workerRepo);
  // Untracked in the worker's checkout, so the worktree reads it from the repo path.
  mkdirSync(join(workerRepo, ".band"), { recursive: true });
  writeFileSync(join(workerRepo, ".band", "environment.json"), JSON.stringify(ENVIRONMENT));

  seedSettings(hubHome, { tokenSecret: TOKEN });
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
  server = await startServer({ tmpHome: hubHome });

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "Env worker",
    labels: [],
  });
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
      workerRoot,
      "--state-dir",
      workerState,
    ],
    {
      env: { ...process.env, HOME: workerHome, BAND_HOME: join(workerHome, ".band") },
      stdio: "ignore",
    },
  );
  await waitFor(async () => ((await hostView())?.status === "online" ? true : undefined), {
    label: "worker online",
    timeoutMs: 30_000,
  });
}, 120_000);

afterAll(async () => {
  if (worker && worker.exitCode === null) {
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    worker.kill("SIGKILL");
    await exited;
  }
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("tool versions", () => {
  it("shows the versions the worker reported in hosts.list", async () => {
    const host = await hostView();
    expect(host?.tools.node).toMatch(/^\d+\.\d+\.\d+$/);
    expect(host?.tools.git).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("finds node >=99 unmet on the worker, using the versions it reported", async () => {
    const repo = await q<{
      issues: unknown[];
      hosts: {
        id: string;
        meets: boolean;
        unmet: { tool: string; range: string; found: string | null }[];
      }[];
    }>("environment.forRepo", { repoName: "proj" });
    expect(repo.issues).toEqual([]);
    const fit = repo.hosts.find((h) => h.id === hostId);
    expect(fit?.meets).toBe(false);
    const node = fit?.unmet.find((u) => u.tool === "node");
    expect(node).toEqual({ tool: "node", range: ">=99", found: (await hostView())?.tools.node });
  });
});

describe("a worktree on the worker", () => {
  it("runs install, start and the declared terminals on the worker", async () => {
    const created = await m<{ path: string }>("worktrees.create", {
      repo: "proj",
      branch: "remote-env",
      hostId,
      hostRepoPath: join(workerRoot, "proj"),
    });
    expect(created.path).toBe(join(workerRoot, ".band-worktrees", "proj", "remote-env"));
    await waitFor(async () => (existsSync(join(created.path, "terminal.txt")) ? true : undefined), {
      label: "declared terminal ran on the worker",
      timeoutMs: 30_000,
    });
    expect(readFileSync(join(created.path, "installed.txt"), "utf8")).toBe("REMOTE-INSTALL\n");
    expect(readFileSync(join(created.path, "started.txt"), "utf8")).toBe("REMOTE-START\n");
  });
});
