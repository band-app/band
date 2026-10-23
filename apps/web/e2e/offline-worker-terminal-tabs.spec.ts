/**
 * A worktree on a worker keeps its terminal tabs across a reload while the
 * worker is offline. `terminal.list` fails for an offline worker, and the
 * center layout used to read that as "no terminals", prune every terminal tab
 * and save the result, so the tabs were gone even after the worker returned.
 * Chat tabs were unaffected because their list comes from the hub.
 *
 * Real production hub with BAND_LOCAL_HOST=off and one real `band-worker`
 * with its own temp HOME, root and state dir. The remote is a local bare
 * repo. No tRPC mocking, no `page.route`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-offline-worker-terminal-tabs-token";
const REPO = "app";

test.use({ viewport: { width: 1600, height: 900 } });

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

const hostStatus = async () => {
  const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
    server.url,
    TOKEN,
    "hosts.list",
  );
  return hosts.find((h) => h.id === hostId)?.status;
};

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome, env: { BAND_LOCAL_HOST: "off" } });

  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: "box-a", labels: [] },
  );
  hostId = issued.hostId;
  const root = tmpDir("band-e2e-offterm-root-");
  worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: hostId,
    },
    root,
    stateDir: tmpDir("band-e2e-offterm-state-"),
    home: tmpDir("band-e2e-offterm-home-"),
  });
  await expect.poll(hostStatus, { timeout: 20_000 }).toBe("online");

  const parent = tmpDir("band-e2e-offterm-remote-");
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
});

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

test("terminal tabs survive a reload while the worktree's worker is offline", async ({ page }) => {
  const app = new WorktreePage(page, server.url, TOKEN);
  await app.goto(worktreeId);
  await app.waitForReady();

  // A new worktree opens on a chat; open two terminals on the worker beside it.
  await expect(app.chatTabs()).toHaveCount(1, { timeout: 20_000 });
  await app.pressNewTerminalShortcut();
  await expect(app.terminalTabs()).toHaveCount(1);
  await app.pressNewTerminalShortcut();
  await expect(app.terminalTabs()).toHaveCount(2);

  await worker.kill();
  await expect.poll(hostStatus, { timeout: 20_000 }).not.toBe("online");

  await app.reload();
  await app.waitForReady();
  await expect(app.terminalTabs()).toHaveCount(2);
  await expect(app.chatTabs()).toHaveCount(1);

  // The first reload must not have saved a layout without them.
  await app.reload();
  await app.waitForReady();
  await expect(app.terminalTabs()).toHaveCount(2);
});
