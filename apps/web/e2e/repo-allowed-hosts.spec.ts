/**
 * Repos limited to chosen hosts, and one host per branch. The user path: add a repo from a worker
 * and see it limited to that worker (S2), change that in Settings > Repos, add a repo by URL with
 * a chosen host, ask for a branch that is already on another host and open it from the New
 * Worktree dialog (S3), see only the primary host's default-branch worktree in every sidebar
 * grouping and switch the primary (S4), and see worktrees on a host that stopped being allowed
 * flagged but still open (S5).
 *
 * Real production hub with BAND_LOCAL_HOST=off and two real `band-worker` processes with their own
 * temp HOME, root and state dir. Remotes are local bare repos. No tRPC mocking, no `page.route`.
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
  seedHostWorktree,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { AddRepoPage } from "./pages/AddRepoPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TwoHostsPage } from "./pages/TwoHostsPage";

const TOKEN = "e2e-repo-allowed-hosts-token";
// Named after the remote URLs below, which end in app.git and url-tool.git.
const REPO = "app";
const URL_REPO = "url-tool";

test.use({ viewport: { width: 1920, height: 900 } });
test.describe.configure({ mode: "serial" });

interface Host {
  id: string;
  name: string;
  root: string;
  /** The worker's HOME, outside its root: the folder picker starts here. */
  home: string;
  worker: WorkerHandle;
}

let server: ServerHandle;
let tmpHome: string;
let a: Host;
let b: Host;
let appRemote = "";
let urlRemote = "";
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

/** A bare remote with one commit on main, and the `git clone` of it a worker can hold. */
function makeRemote(name: string): string {
  const parent = tmpDir(`band-e2e-allowed-${name}-`);
  const seed = join(parent, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), `hello from ${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  const bare = join(parent, `${name}.git`);
  git(parent, "clone", "-q", "--bare", seed, bare);
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  return bare;
}

async function startHost(name: string): Promise<Host> {
  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: name, labels: [] },
  );
  const root = tmpDir(`band-e2e-allowed-${name}-root-`);
  const home = tmpDir(`band-e2e-allowed-${name}-home-`);
  const worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: issued.hostId,
    },
    root,
    stateDir: tmpDir(`band-e2e-allowed-${name}-state-`),
    home,
  });
  return { id: issued.hostId, name, root, home, worker };
}

interface RepoRow {
  name: string;
  allowedHostIds: string[] | null;
  primaryHostId: string | null;
  worktrees: Array<{ worktreeId: string; hostNotAllowed?: boolean }>;
}
const repoRow = async (name: string): Promise<RepoRow | undefined> =>
  (await trpcQuery<{ repos: RepoRow[] }>(server.url, TOKEN, "repos.list")).repos.find(
    (r) => r.name === name,
  );

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome, env: { BAND_LOCAL_HOST: "off" } });
  a = await startHost("box-a");
  b = await startHost("box-b");
  await expect
    .poll(async () => {
      const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
        server.url,
        TOKEN,
        "hosts.list",
      );
      return [a.id, b.id].every((id) => hosts.find((h) => h.id === id)?.status === "online");
    })
    .toBe(true);

  appRemote = makeRemote("app");
  urlRemote = makeRemote("url-tool");
  // A's checkout of `app` is in its home, where the folder picker starts.
  git(a.home, "clone", "-q", appRemote, "app");
  // B holds a clone of `app` too: its default-branch worktree is the one the sidebar hides.
  git(b.root, "clone", "-q", appRemote, "app");
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await a?.worker.kill();
  await b?.worker.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

test("a repo added from a worker is limited to it, and Settings > Repos changes that (S2)", async ({
  page,
}) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  const addRepo = new AddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseWorker(a.id);
  await addRepo.openFolder("app");
  await addRepo.useCurrentFolder();
  // The defaults for a repo found on a worker: only that worker, and it is the primary.
  await addRepo.hosts.expectOnly([a.id], a.id);
  // The home is outside the worker's root, so adding the folder adds it as a root.
  await addRepo.confirmRoot();
  await expect(addRepo.closed()).toBeHidden();

  const added = await repoRow(REPO);
  expect(added?.allowedHostIds).toEqual([a.id]);
  expect(added?.primaryHostId).toBe(a.id);
  const repoName = REPO;

  // The repo's page in Settings > Repos shows the same, and the user makes the repo available everywhere.
  await settings.openRepoSettings(repoName);
  await expect(settings.repoAllowedMode(repoName)).toHaveValue("only");
  await expect(settings.repoWorkerRows(repoName)).toHaveCount(1);
  await expect(settings.repoClone(repoName, a.id)).toHaveAttribute("data-primary", "true");
  // A limited repo keeps at least one worker.
  await expect(settings.repoRemoveWorkerButton(repoName, a.id)).toBeDisabled();

  await settings.setRepoAllowedMode(repoName, "all");
  await expect.poll(async () => (await repoRow(repoName))?.allowedHostIds).toBeNull();
});

test("a repo added by URL is available everywhere unless the user limits it (S2)", async ({
  page,
}) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  const addRepo = new AddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseUrl();
  await addRepo.hosts.expectAllHosts();
  await addRepo.hosts.chooseOnly([b.id]);
  await addRepo.hosts.choosePrimary(b.id);
  await addRepo.addByUrl(urlRemote, "main");
  await expect(addRepo.closed()).toBeHidden();

  const added = await repoRow(URL_REPO);
  expect(added?.allowedHostIds).toEqual([b.id]);
  expect(added?.primaryHostId).toBe(b.id);

  // The New Worktree dialog offers only the allowed host, so it shows no picker.
  const app = new TwoHostsPage(page, server.url, TOKEN);
  await settings.goto();
  await app.worktree.openNewWorktreeDialog(URL_REPO);
  await expect(app.worktree.newWorktreeBranchInput).toBeVisible();
  await expect(app.worktree.newWorktreeHostSelect).toHaveCount(0);
});

test("a branch on another host is refused and the dialog opens it (S3)", async ({ page }) => {
  const repoName = REPO;
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: repoName,
    branch: "feat-x",
    hostId: a.id,
  });
  const onA = `${repoName}-feat-x@${a.id}`;
  await expect
    .poll(async () => (await repoRow(repoName))?.worktrees.map((w) => w.worktreeId))
    .toContain(onA);

  const app = new TwoHostsPage(page, server.url, TOKEN);
  await app.open(onA);
  await app.worktree.openNewWorktreeDialog(repoName);
  await app.worktree.newWorktreeHostSelect.selectOption(b.id);
  await app.worktree.fillNewWorktreeBranch("feat-x");
  await expect(app.worktree.newWorktreeSlugError).toBeVisible();
  await expect(app.worktree.newWorktreeBranchInput).toHaveAttribute("aria-invalid", "true");
  await expect(
    app.worktree.newWorktreeDialog.getByRole("button", { name: "Create" }),
  ).toBeDisabled();
  await app.worktree.openNewWorktreeSlugError();
  await expect(app.worktree.newWorktreeSlugErrorMessage).toHaveText("feat-x is already on box-a");
  await expect(app.worktree.newWorktreeOpenExisting).toBeVisible();

  // A branch that is free goes through on that same host, so the refusal is about the branch.
  await app.worktree.fillNewWorktreeBranch("feat-y");
  await expect(app.worktree.newWorktreeSlugError).toBeHidden();
  await expect(app.worktree.newWorktreeOpenExisting).toBeHidden();

  // The hub says the same when asked directly, with the worktree to open.
  const res = await fetch(`${server.url}/trpc/worktrees.create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ repo: repoName, branch: "feat-x", hostId: b.id, noOrigin: true }),
  });
  expect(res.status).toBe(409);
  const body = (await res.json()) as {
    error: { message: string; data: { existingWorktreeId: string } };
  };
  expect(body.error.message).toBe("feat-x is already on box-a");
  expect(body.error.data.existingWorktreeId).toBe(onA);

  await app.worktree.fillNewWorktreeBranch("feat-x");
  await app.worktree.openNewWorktreeSlugError();
  await app.worktree.newWorktreeOpenExisting.click();
  await expect.poll(() => app.currentPath()).toBe(`/worktree/${onA}`);
});

test("only the primary host's default-branch worktree is listed in every grouping (S4)", async ({
  page,
}) => {
  const repoName = REPO;
  // B holds a clone of the repo with its default branch checked out, as an older install records it.
  seedHostWorktree(tmpHome, {
    repo: repoName,
    name: "main",
    branch: "main",
    path: join(b.root, "app"),
    hostId: b.id,
  });
  await trpcMutate(server.url, TOKEN, "repos.update", { name: repoName, primaryHostId: a.id });
  const mainA = `${repoName}-main@${a.id}`;
  const mainB = `${repoName}-main@${b.id}`;

  const app = new TwoHostsPage(page, server.url, TOKEN);
  const settings = new SettingsPage(page, server.url, TOKEN);
  await app.open(mainA);
  await expect(app.card(mainA)).toBeVisible();
  await expect(app.card(mainB)).toHaveCount(0);

  // Making B the primary switches which one is listed. Nothing moves on disk.
  await settings.openRepoSettings(repoName);
  await settings.makeRepoPrimary(repoName, b.id);
  await expect.poll(async () => (await repoRow(repoName))?.primaryHostId).toBe(b.id);
  await settings.closeDialog();
  await expect(app.card(mainB)).toBeVisible();
  await expect(app.card(mainA)).toHaveCount(0);
});

test("worktrees on a host that stopped being allowed are flagged and still open (S5)", async ({
  page,
}) => {
  const repoName = REPO;
  const onA = `${repoName}-feat-x@${a.id}`;
  // Limit the repo to B: A's worktree stays, flagged.
  await trpcMutate(server.url, TOKEN, "repos.update", {
    name: repoName,
    allowedHostIds: [b.id],
    primaryHostId: b.id,
  });
  const app = new TwoHostsPage(page, server.url, TOKEN);
  await app.open(onA);
  await expect(app.worktree.notAllowedMark(onA)).toBeVisible();
  await expect(app.card(onA)).toBeVisible();
  // It opens: the page is on that worktree and its files are still there.
  await app.worktree.waitForWorktreeReady(onA);
  expect(
    await repoRow(repoName).then((r) => r?.worktrees.find((w) => w.worktreeId === onA)),
  ).toMatchObject({
    hostNotAllowed: true,
  });

  // The repo's settings page still lists A with its worktree, marked not allowed and with no controls.
  // Settings opens over the worktree, whose live streams never let the network go idle for `goto`.
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.openRepoSettings(repoName);
  await expect(settings.repoClone(repoName, a.id)).toHaveAttribute("data-allowed", "false");
  await expect(settings.repoClone(repoName, a.id)).toHaveAttribute("data-worktrees", "1");
  await expect(settings.repoPrimarySwitch(repoName, a.id)).toHaveCount(0);
  await expect(settings.repoRemoveWorkerButton(repoName, a.id)).toHaveCount(0);
});
