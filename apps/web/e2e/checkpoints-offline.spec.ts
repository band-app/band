/**
 * A worktree on a worker keeps working as a read-only view when the worker goes away. The hub takes
 * a checkpoint of a worktree with an uncommitted and an untracked file (S1), the worker is stopped,
 * and the worktree shows as offline with the checkpoint time (S2): the card badge, the banner, and
 * the Changes and Files panels read from the checkpoint. A second checkpoint call with nothing new
 * stores nothing.
 *
 * Real production hub with BAND_LOCAL_HOST=off and one real `band-worker` with its own temp HOME,
 * root and state dir. The remote is a local bare repo. No tRPC mocking, no `page.route`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
import { CheckpointsPage } from "./pages/CheckpointsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-checkpoints-offline-token";
const REPO = "app";

test.use({ viewport: { width: 1920, height: 900 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;
let hostId = "";
let worker: WorkerHandle;
let worktreeId = "";
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
  worktrees: Array<{
    worktreeId: string;
    name: string;
    path: string;
    lastCheckpointAt: number | null;
  }>;
}
const worktreeRow = async () =>
  (await trpcQuery<{ repos: RepoRow[] }>(server.url, TOKEN, "repos.list")).repos
    .find((r) => r.name === REPO)
    ?.worktrees.find((w) => w.worktreeId === worktreeId);

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  // A short lease, so the test sees the countdown and its end.
  server = await startServer({
    tmpHome,
    env: { BAND_LOCAL_HOST: "off", BAND_WORKER_LEASE_MS: "12000" },
  });

  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: "box-a", labels: [] },
  );
  hostId = issued.hostId;
  const root = tmpDir("band-e2e-ckpt-root-");
  worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: hostId,
    },
    root,
    stateDir: tmpDir("band-e2e-ckpt-state-"),
    home: tmpDir("band-e2e-ckpt-home-"),
  });
  await expect
    .poll(async () => {
      const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
        server.url,
        TOKEN,
        "hosts.list",
      );
      return hosts.find((h) => h.id === hostId)?.status;
    })
    .toBe("online");

  // A bare remote with one commit, and the worker's clone of it inside its root.
  const parent = tmpDir("band-e2e-ckpt-remote-");
  const seed = join(parent, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  const bare = join(parent, "app.git");
  git(parent, "clone", "-q", "--bare", seed, bare);
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "clone", "-q", bare, "app");

  await trpcMutateData(server.url, TOKEN, "repos.addByUrl", {
    remoteUrl: bare,
    defaultBranch: "main",
  });
  await trpcMutateData(server.url, TOKEN, "worktrees.create", {
    repo: REPO,
    branch: "feat-x",
    hostId,
    hostRepoPath: join(root, "app"),
  });
  worktreeId = `${REPO}-feat-x@${hostId}`;
  await expect.poll(async () => (await worktreeRow())?.path).toBeTruthy();
  const path = (await worktreeRow())?.path ?? "";
  // An uncommitted change to a tracked file and an untracked file.
  writeFileSync(join(path, "hello.txt"), "hello from the checkpoint\n");
  writeFileSync(join(path, "notes.md"), "untracked notes\n");
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

test("a checkpoint is taken once, and the worktree is readable from it when the host is offline (S1, S2)", async ({
  page,
}) => {
  const created = await trpcMutateData<{ status: string }>(server.url, TOKEN, "checkpoints.take", {
    worktreeId,
  });
  expect(created.status).toBe("created");
  // Nothing changed since, so nothing is stored.
  const again = await trpcMutateData<{ status: string }>(server.url, TOKEN, "checkpoints.take", {
    worktreeId,
  });
  expect(again.status).toBe("unchanged");
  const listed = await trpcQuery<{ checkpoints: unknown[] }>(
    server.url,
    TOKEN,
    "checkpoints.list",
    { worktreeId },
  );
  expect(listed.checkpoints).toHaveLength(1);

  await worker.kill();

  const app = new WorktreePage(page, server.url, TOKEN);
  const checkpoints = new CheckpointsPage(page);
  await app.goto(worktreeId);
  await app.waitForReady();

  // The card shows an icon, faded, with the details in its tooltip.
  await expect(checkpoints.offlineIcon(worktreeId)).toBeVisible({ timeout: 30_000 });
  await expect(checkpoints.offlineIcon(worktreeId)).not.toContainText("checkpoint");
  await expect(checkpoints.card(worktreeId)).toHaveCSS("opacity", "0.6");
  await checkpoints.showOfflineDetails(worktreeId);
  await expect(checkpoints.offlineDetails).toContainText("Last seen");
  await expect(checkpoints.offlineDetails).toContainText("Last checkpoint");

  // Opening it shows the notice. The old host may still be running until its lease ends, so the
  // button counts down and cannot be pressed yet.
  await expect(checkpoints.noticeHost).toContainText("box-a is offline");
  await expect(checkpoints.noticeHost).toContainText("Last checkpoint");
  await expect(checkpoints.noticeBlocked).toBeVisible();
  await expect(checkpoints.leaseCountdown).toBeVisible();
  await expect(checkpoints.openElsewhereButton).toBeDisabled();
  // Once it ends, no other host is online: the reason stays, and there is no button.
  await expect(checkpoints.openElsewhereButton).toHaveCount(0, { timeout: 30_000 });
  await expect(checkpoints.noticeBlocked).toBeVisible();
  await expect(checkpoints.panel).toHaveCount(0);
  await expect(checkpoints.sidepanelPlaceholder).toBeVisible();

  // The read-only checkpoint view stays one click away.
  await checkpoints.viewCheckpoint();
  await checkpoints.openChanges();
  await expect(checkpoints.change("hello.txt")).toBeVisible();
  await expect(checkpoints.change("notes.md")).toBeVisible();
  await checkpoints.expectChangeDiff("hello.txt", "hello from the checkpoint");

  await checkpoints.openExplorer();
  await checkpoints.expectFileContent("notes.md", "untracked notes");
});
