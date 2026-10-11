// Integration test for GH_TOKEN on a runner-started worker. A real hub (the
// production bundle, temp BAND_HOME) starts a real `band-worker` through the
// bundled `local` runner hook, with a temp HOME. The hub's vault holds a `git`
// item for github.com. The agent-side process (a terminal here) must see it as
// GH_TOKEN, and it must be on no disk of the worker and in no log.

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
import { toWorktreeId } from "@band-app/shared/worktree-id";
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

const TOKEN = "gh-token-shared-secret";
const GIT_TOKEN = "gitpat_s3cr3t_0123456789abcdef";
const GH_TOKEN = "ghp_workerVaultToken0123456789";
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

interface ReposList {
  repos: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
}

let server: ServerHandle;
let stub: GitHttpAuthStub;
let bare: string;
let runnerDir: string;
let worktreeId = "";
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

/** Runs one shell line in a terminal on the worktree's worker and returns what it printed. */
async function inWorkerShell(line: string): Promise<string> {
  const { terminalId } = await m<{ terminalId: string }>("terminal.create", { worktreeId });
  const socket = await TerminalSocket.open(server, { worktreeId, terminalId, token: TOKEN });
  try {
    socket.type(`${line}; echo END-$((6*7))\r`);
    await socket.waitForOutput("END-42", 30_000);
    return socket.output;
  } finally {
    await socket.close();
  }
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-ghtoken-hub-");
  scratch.push(hubHome);
  const base = tmp("band-ghtoken-");
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
    repos: [
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

describe("GH_TOKEN on a worker the runner starts", () => {
  it("S3: a process the worker starts sees GH_TOKEN, and no file or log holds it", async () => {
    // The clone needs the stub's credential, and gh needs the github.com one.
    await putGitItem("proj");
    await m("vault.put", {
      name: "github-com",
      kind: "git",
      host: "github.com",
      pathPattern: "**",
      value: GH_TOKEN,
    });
    await m("settings.update", {
      runners: [
        {
          id: "local",
          spawn: "bundled:local",
          destroy: "bundled:local",
          labels: { pool: "gh" },
          isolation: "process",
          maxConcurrent: 1,
          timeoutSec: 90,
          env: { BAND_WORKER_BIN: WORKER_BIN, BAND_IDLE_EXIT: "300s", ...identity },
        },
      ],
    });
    const created = await m<{ provisioning?: { requestId: string } }>("worktrees.create", {
      repo: "proj",
      branch: "gh-feat",
      placement: { labels: { pool: "gh" } },
    });
    const wt = await waitFor(
      async () =>
        (await q<ReposList>("repos.list")).repos
          .find((p) => p.name === "proj")
          ?.worktrees.find((w) => w.name === "gh-feat"),
      { label: "worktree on the worker", timeoutMs: 90_000, intervalMs: 250 },
    );
    hostId = wt.hostId ?? "";
    worktreeId = toWorktreeId("proj", "gh-feat", hostId);

    // Length and prefix, so the token is not in the echo of the typed command.
    const out = await inWorkerShell(
      'echo "LEN-$(printf %s "$GH_TOKEN" | wc -c | tr -d " ")-HEAD-$(printf %s "$GH_TOKEN" | cut -c1-7)"',
    );
    expect(out).toContain(`LEN-${GH_TOKEN.length}-HEAD-${GH_TOKEN.slice(0, 7)}`);

    expect(filesContaining(join(runnerDir, hostId), GH_TOKEN)).toEqual([]);
    const { log } = await q<{ log: string | null }>("runners.log", {
      requestId: created.provisioning?.requestId,
    });
    expect(log).not.toContain(GH_TOKEN);
  }, 180_000);
});
