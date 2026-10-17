/**
 * "Open on another host…" while the worktree's host is online moves it. Two real `band-worker`s
 * (A and B) dial a real production hub. A worktree on A is opened from its card's menu; the dialog
 * says ignored files are not carried over, and submitting moves it to B, where it lists with the
 * uncommitted file it had. The remote is a local bare repo. No tRPC mocking, no `page.route`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { MoveWorktreePage } from "./pages/MoveWorktreePage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-move-worktree-token";

test.use({ viewport: { width: 1920, height: 900 } });

let server: ServerHandle;
let tmpHome: string;
const workers: Array<{ hostId: string; root: string; handle: WorkerHandle }> = [];
const scratch: string[] = [];

const tmpDir = (prefix: string) => {
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

interface RepoRow {
  name: string;
  worktrees: Array<{ name: string; path: string; hostId?: string }>;
}
const worktreeRow = async (name: string, hostId: string) =>
  (await trpcQuery<{ repos: RepoRow[] }>(server.url, TOKEN, "repos.list")).repos
    .find((r) => r.name === "app")
    ?.worktrees.find((w) => w.name === name && w.hostId === hostId);

async function addWorker(name: string): Promise<{ hostId: string; root: string }> {
  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: name, labels: [] },
  );
  const root = tmpDir(`band-e2e-move-${name}-root-`);
  const handle = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: issued.hostId,
    },
    root,
    stateDir: tmpDir(`band-e2e-move-${name}-state-`),
    home: tmpDir(`band-e2e-move-${name}-home-`),
  });
  workers.push({ hostId: issued.hostId, root, handle });
  await expect
    .poll(async () => {
      const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
        server.url,
        TOKEN,
        "hosts.list",
      );
      return hosts.find((h) => h.id === issued.hostId)?.status;
    })
    .toBe("online");
  return { hostId: issued.hostId, root };
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome, env: { BAND_LOCAL_HOST: "off" } });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  for (const w of workers) await w.handle.kill();
  await server?.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

test.describe.configure({ mode: "serial" });

test("the card menu moves a worktree on an online host to another host", async ({ page }) => {
  const a = await addWorker("box-a");
  const b = await addWorker("box-b");

  const parent = tmpDir("band-e2e-move-remote-");
  const seed = join(parent, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  const bare = join(parent, "app.git");
  git(parent, "clone", "-q", "--bare", seed, bare);
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  git(a.root, "clone", "-q", bare, "app");
  git(b.root, "clone", "-q", bare, "app");
  await trpcMutateData(server.url, TOKEN, "repos.addByUrl", {
    remoteUrl: bare,
    defaultBranch: "main",
  });
  await trpcMutateData(server.url, TOKEN, "worktrees.create", {
    repo: "app",
    branch: "feat-move",
    hostId: a.hostId,
    hostRepoPath: join(a.root, "app"),
  });
  await expect.poll(async () => (await worktreeRow("feat-move", a.hostId))?.path).toBeTruthy();
  const path = (await worktreeRow("feat-move", a.hostId))?.path ?? "";
  writeFileSync(join(path, "notes.md"), "moves with the worktree\n");

  const worktreeId = `app-feat-move@${a.hostId}`;
  const app = new WorktreePage(page, server.url, TOKEN);
  const move = new MoveWorktreePage(page);
  await app.goto(worktreeId);
  await app.waitForReady();

  await move.openFromCard(worktreeId);
  await expect(move.dialog).toBeVisible();
  await expect(move.ignoredFilesNote).toBeVisible();
  await move.submit();
  await expect(move.result).toBeVisible({ timeout: 90_000 });

  const moved = await worktreeRow("feat-move", b.hostId);
  expect(moved?.path).toBeTruthy();
  expect(readFileSync(join(moved?.path ?? "", "notes.md"), "utf8")).toBe(
    "moves with the worktree\n",
  );
});

test("the default branch on an online host offers Open on another host too (S13)", async ({
  page,
}) => {
  const a = workers[0];
  expect(a).toBeDefined();
  await trpcMutateData(server.url, TOKEN, "repos.addFromWorker", {
    hostId: a?.hostId,
    path: join(a?.root ?? "", "app"),
  });
  await trpcMutateData(server.url, TOKEN, "repos.update", {
    name: "app",
    primaryHostId: a?.hostId,
  });
  const mainId = `app-main@${a?.hostId}`;
  const app = new WorktreePage(page, server.url, TOKEN);
  const move = new MoveWorktreePage(page);
  await app.goto(mainId);
  await app.waitForReady();

  await move.openCardMenu(mainId);
  await expect(move.menuItem).toBeEnabled();
});
