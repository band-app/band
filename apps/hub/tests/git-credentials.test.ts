// Integration tests for git credentials on workers (plan step 4.1). A real hub
// (the production bundle, temp BAND_HOME) starts a real `band-worker` through
// the bundled `local` runner hook. The project's origin is a local git HTTP
// server that requires basic auth, and the hub holds a `git` vault item for it.
// The hook has no credential, so the hub clones the repository through the
// worker, whose git asks the hub for the token (`git.credential` over the link).

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitHttpAuthStub, startGitHttpAuthStub } from "./fixtures/git-http-auth-stub";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "git-credentials-shared-secret";
const GIT_TOKEN = "gitpat_s3cr3t_0123456789abcdef";
const GIT_USER = "band-bot";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });
}

interface ProjectsList {
  projects: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
}

let server: ServerHandle;
let stub: GitHttpAuthStub;
let bare: string;
let runnerDir: string;
let workspaceId = "";
let hostId = "";

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

const putGitItem = (pathPattern: string) =>
  m("vault.put", {
    name: "stub-git",
    kind: "git",
    host: stub.host,
    pathPattern,
    username: GIT_USER,
    value: GIT_TOKEN,
  });

/** Every file under `dir` whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const visit = (path: string) => {
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (info.isFile() && info.size < 8 * 1024 * 1024) {
      if (readFileSync(path).includes(needle)) hits.push(path);
    }
  };
  visit(dir);
  return hits;
}

/** Runs one shell line in a terminal on the workspace's worker and returns what it printed. */
async function inWorkerShell(line: string): Promise<string> {
  const { terminalId } = await m<{ terminalId: string }>("terminal.create", { workspaceId });
  const socket = await TerminalSocket.open(server, { workspaceId, terminalId, token: TOKEN });
  try {
    socket.type(`${line}; echo END-$((6*7))\r`);
    await socket.waitForOutput("END-42", 30_000);
    return socket.output;
  } finally {
    await socket.close();
  }
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-gitcred-hub-");
  scratch.push(hubHome);
  const base = tmp("band-gitcred-");
  runnerDir = join(hubHome, ".band", "runners", "local");
  const remotes = join(base, "remotes");
  bare = join(remotes, "proj.git");
  mkdirSync(remotes, { recursive: true });

  // The private repository: a bare repo behind the auth stub, seeded through the file system.
  const seed = join(base, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), "private hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(base, "clone", "-q", "--bare", seed, bare);
  git(bare, "config", "http.receivepack", "true");
  stub = await startGitHttpAuthStub(remotes, { username: GIT_USER, password: GIT_TOKEN });

  // The hub's checkout names the stub as origin, with no credential in the URL.
  const hubRepo = join(base, "hub", "proj");
  mkdirSync(join(base, "hub"));
  git(base, "clone", "-q", bare, hubRepo);
  git(hubRepo, "remote", "set-url", "origin", `${stub.url}/proj.git`);

  seedSettings(hubHome, { tokenSecret: TOKEN });
  seedState(hubHome, {
    projects: [
      {
        name: "proj",
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false" },
  });
}, 120_000);

afterAll(async () => {
  if (existsSync(runnerDir)) {
    for (const dir of readdirSync(runnerDir, { recursive: true }).map(String)) {
      if (!dir.endsWith("pid")) continue;
      try {
        process.kill(Number(readFileSync(join(runnerDir, dir), "utf8").trim()), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await server?.close();
  await stub?.stop();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("the vault's git credentials", () => {
  it("stores one with its host and path pattern and never returns the token", async () => {
    const put = await m<{ item: { kind: string; metadata: Record<string, unknown> } }>(
      "vault.put",
      {
        name: "stub-git",
        kind: "git",
        host: stub.host,
        pathPattern: "proj",
        username: GIT_USER,
        value: GIT_TOKEN,
      },
    );
    expect(put.item.kind).toBe("git");
    expect(put.item.metadata).toEqual({ host: stub.host, pathPattern: "proj", username: GIT_USER });
    const list = JSON.stringify(await q("vault.list"));
    expect(list).toContain("stub-git");
    expect(list).not.toContain(GIT_TOKEN);
  });

  it("refuses vault.put without a token and with a non-admin device token", async () => {
    const body = { name: "nope", kind: "git", host: "github.com", pathPattern: "a/*", value: "x" };
    expect((await trpcMutate(server.url, "vault.put", body)).status).toBe(401);
    const created = await trpcMutate(server.url, "tokens.createDevice", { label: "plain" }, TOKEN);
    const device = (await trpcData<{ token: string }>(created)).token;
    expect((await trpcMutate(server.url, "vault.put", body, device)).status).toBe(403);
  });

  it("refuses a git item with no host or a bad path pattern", async () => {
    for (const bad of [
      { host: "", pathPattern: "a/*" },
      { host: "github.com", pathPattern: "" },
      { host: "github.com", pathPattern: "a b" },
      { host: "not a host", pathPattern: "a/*" },
    ]) {
      const res = await trpcMutate(
        server.url,
        "vault.put",
        { name: "bad", kind: "git", value: "x", ...bad },
        TOKEN,
      );
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("a worker the runner starts", () => {
  it("clones the private repository with the vault credential (S1)", async () => {
    await m("settings.update", {
      runners: [
        {
          id: "local",
          spawn: "bundled:local",
          destroy: "bundled:local",
          labels: { pool: "git" },
          isolation: "process",
          maxConcurrent: 1,
          timeoutSec: 90,
          env: {
            BAND_WORKER_BIN: WORKER_BIN,
            BAND_IDLE_EXIT: "300s",
            ...identity,
          },
        },
      ],
    });
    const created = await m<{ provisioning?: { requestId: string } }>("workspaces.create", {
      project: "proj",
      branch: "git-feat",
      placement: { labels: { pool: "git" } },
    });
    expect(created.provisioning?.requestId).toBeTruthy();
    const wt = await waitFor(
      async () =>
        (await q<ProjectsList>("projects.list")).projects
          .find((p) => p.name === "proj")
          ?.worktrees.find((w) => w.name === "git-feat"),
      { label: "workspace on the worker", timeoutMs: 90_000, intervalMs: 250 },
    );
    hostId = wt.hostId ?? "";
    expect(hostId).toMatch(/^h-/);
    workspaceId = "proj-git-feat";

    // The server saw the credential, and the clone is on the worker's disk.
    expect(stub.authenticated).toContain(GIT_USER);
    const workerDir = join(runnerDir, hostId);
    expect(readFileSync(join(workerDir, "work", "proj", "hello.txt"), "utf8")).toBe(
      "private hello\n",
    );

    // The token is in no file the worker wrote, nor in its log.
    expect(filesContaining(workerDir, GIT_TOKEN)).toEqual([]);
    const { log } = await q<{ log: string | null }>("runners.log", {
      requestId: created.provisioning?.requestId,
    });
    expect(log).not.toContain(GIT_TOKEN);
  }, 150_000);

  it("pushes a commit from the worktree through the helper (S2)", async () => {
    await m("workspace.createFile", {
      workspaceId,
      path: "pushed.txt",
      content: "from the worker\n",
    });
    await m("workspace.gitCommit", { workspaceId, message: "add pushed.txt" });
    const before = stub.authenticated.length;
    await m("workspace.gitPush", { workspaceId });
    expect(stub.authenticated.length).toBeGreaterThan(before);
    expect(git(bare, "show", "git-feat:pushed.txt")).toBe("from the worker\n");
    expect(filesContaining(join(runnerDir, hostId), GIT_TOKEN)).toEqual([]);
  }, 60_000);

  it("does not put the token in the environment of a process it starts", async () => {
    const out = await inWorkerShell("env | grep gitpat_ || echo NO-TOKEN-IN-ENV");
    expect(out).toContain("NO-TOKEN-IN-ENV");
    expect(out).not.toContain(GIT_TOKEN);
    expect(await inWorkerShell("git ls-remote origin >/dev/null && echo LS-OK")).toContain("LS-OK");
  }, 60_000);

  it("gives no credential for a remote that matches no vault item (S3)", async () => {
    await putGitItem("someone-else/*");
    try {
      const out = await inWorkerShell("git ls-remote origin >/dev/null 2>&1; echo RC-$?");
      expect(out).toMatch(/RC-[1-9]/);
      expect(out).not.toContain(GIT_TOKEN);
    } finally {
      await putGitItem("proj");
    }
  }, 60_000);

  it("refuses a repository that is not placed on the worker (S3)", async () => {
    const before = stub.authenticated.length;
    const out = await inWorkerShell(
      `printf 'protocol=http\\nhost=${stub.host}\\npath=other/repo.git\\n\\n' | git credential fill 2>&1 | grep -v '^$' | head -3; true`,
    );
    expect(out).toContain("not placed on this worker");
    expect(out).not.toContain("password=");
    expect(out).not.toContain(GIT_TOKEN);
    expect(stub.authenticated.length).toBe(before);
  }, 60_000);

  it("treats store and erase as no-ops and writes nothing to disk", async () => {
    const out = await inWorkerShell(
      `for a in approve reject; do printf 'protocol=http\\nhost=${stub.host}\\npath=proj.git\\nusername=u\\npassword=${GIT_TOKEN}\\n\\n' | git credential $a; echo RC-$a-$?; done`,
    );
    expect(out).toContain("RC-approve-0");
    expect(out).toContain("RC-reject-0");
    expect(filesContaining(join(runnerDir, hostId), GIT_TOKEN)).toEqual([]);
  }, 60_000);

  it("refuses a remote the agent added to its own checkout", async () => {
    const out = await inWorkerShell(
      `git remote add sneaky http://${stub.host}/other/repo.git; printf 'protocol=http\\nhost=${stub.host}\\npath=other/repo.git\\n\\n' | git credential fill 2>&1 | head -3; git remote remove sneaky; true`,
    );
    expect(out).toContain("not placed on this worker");
    expect(out).not.toContain(GIT_TOKEN);
  }, 60_000);
});
