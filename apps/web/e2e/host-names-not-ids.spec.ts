/**
 * A worktree on a worker is shown by its repo, branch and host name, never by its id. The id ends
 * in `@h-<hex>`, which the empty chat used to print as its title (S1, S2).
 *
 * Real production hub, a real `band-worker` named "e2e-box", a real browser, temp dirs only.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { ChatPanePage } from "./pages/ChatPanePage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-host-names-token";
const RAW_ID = /@h-[0-9a-f]+|\bh-[0-9a-f]{8,}\b/;

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle | undefined;
let remote = "";
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const hubRepo = join(tmpDir("band-e2e-hostnames-"), "borko");
  makeRepo(hubRepo);
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    repos: [
      {
        name: "borko",
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  server = await startServer({ tmpHome });

  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: "e2e-box", labels: [] },
  );
  const hostId = issued.hostId;
  const workerRoot = tmpDir("band-e2e-hostnames-wroot-");
  makeRepo(join(workerRoot, "borko"));
  worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: hostId,
    },
    root: workerRoot,
    stateDir: tmpDir("band-e2e-hostnames-state-"),
    home: tmpDir("band-e2e-hostnames-whome-"),
  });
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
          server.url,
          TOKEN,
          "hosts.list",
        );
        return hosts.find((h) => h.id === hostId)?.status;
      },
      { timeout: 20_000 },
    )
    .toBe("online");
  remote = toWorktreeId("borko", "feature", hostId);
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: "borko",
    branch: "feature",
    hostId,
    hostRepoPath: join(workerRoot, "borko"),
    noOrigin: true,
  });
  await trpcMutate(server.url, TOKEN, "chats.create", {
    worktreeId: remote,
    id: "chat_hostnames",
    name: "Names",
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

test("the empty chat of a worktree on a worker is titled by names, with no host id on screen (S1, S2)", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(remote);
  await worktreePage.waitForReady();
  const chat = new ChatPanePage(page, server.url, TOKEN);

  await expect(chat.emptyConversation).toBeVisible();
  await expect(chat.emptyConversation).toContainText("borko · feature on e2e-box");
  expect(await chat.screenText()).not.toMatch(RAW_ID);
});
