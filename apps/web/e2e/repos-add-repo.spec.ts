/**
 * Add repo from the sidebar's Repos panel. The user path: add a worker from Settings > Hosts, run
 * the real `band-worker` binary with a temp HOME, pick a git folder in the worker's home through
 * the folder picker, read its remote URL and branch in the preview, confirm that it is outside the
 * worker's roots, and find the repo in Settings > Repos. Other cases: a folder with no remote says
 * it stays on that worker, By URL shows the default branch the hub read from a local bare remote,
 * a label filter labels the new repo, Settings > Repos has no Add repo, and a second server with
 * the hub's local host off and no worker shows the "no worker online" notice and still adds a repo
 * by URL. Real hub and worker, local bare repos as remotes, never the real `~/.band`.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { parseWorkerCommand, startWorker, type WorkerHandle } from "./helpers/worker";
import { AddRepoPage } from "./pages/AddRepoPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial" });

const TOKEN = "e2e-repos-add-repo-token";
const LABEL = "work";

let server: ServerHandle;
let tmpHome: string;
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** An empty bare repository on `main`, to use as a remote. */
function bareRemote(name: string): string {
  const parent = tmpDir("band-e2e-reposadd-remotes-");
  const origin = join(parent, `${name}.git`);
  git(parent, ["init", "--bare", "-b", "main", origin], parent);
  return origin;
}

/** A git repository with one commit, and an `origin` bare repository next to it when `withOrigin`. */
function seedRepo(
  parent: string,
  name: string,
  home: string,
  withOrigin = true,
): { path: string; origin: string } {
  const origin = join(parent, `${name}-origin.git`);
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"], home);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  git(path, ["add", "."], home);
  git(path, ["commit", "-m", "seed"], home);
  if (withOrigin) {
    git(parent, ["init", "--bare", "-b", "main", origin], home);
    git(path, ["remote", "add", "origin", origin], home);
    git(path, ["push", "origin", "main"], home);
  }
  return { path, origin };
}

async function trpc(url: string, path: string, input: unknown): Promise<unknown> {
  const res = await fetch(`${url}/trpc/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} failed: ${JSON.stringify(body)}`);
  return body.result.data;
}

async function findRepo(
  url: string,
  name: string,
): Promise<
  { name: string; remoteUrl?: string; defaultBranch?: string; label?: string } | undefined
> {
  const res = await fetch(`${url}/trpc/repos.list`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await res.json();
  return body.result.data.repos.find((r: { name: string }) => r.name === name);
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    labels: [{ id: LABEL, name: "Work", color: "#3b82f6" }],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

let worker: WorkerHandle | undefined;
let hostId = "";

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

test("adds a repo from a worker folder through the picker", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  await settingsPage.addWorker("picker-box", "");
  const env = parseWorkerCommand(await settingsPage.readWorkerCommand());
  hostId = env.BAND_WORKER_ID;

  const workerHome = tmpDir("band-e2e-addrepo-home-");
  const root = tmpDir("band-e2e-addrepo-root-");
  // A checkout in the worker's home, outside its only root.
  const { origin } = seedRepo(workerHome, "from-worker", workerHome);
  seedRepo(workerHome, "no-remote", workerHome, false);
  worker = startWorker({
    env: {
      BAND_HUB_URL: env.BAND_HUB_URL,
      BAND_BOOTSTRAP_TOKEN: env.BAND_BOOTSTRAP_TOKEN,
      BAND_WORKER_ID: hostId,
    },
    root,
    stateDir: tmpDir("band-e2e-addrepo-state-"),
    home: workerHome,
  });
  await expect(settingsPage.hostRow(hostId)).toHaveAttribute("data-status", "online", {
    timeout: 20_000,
  });
  await settingsPage.goto();

  const addRepo = new AddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseWorker(hostId);
  // The picker starts in the worker's home and lists the folder with the checkout.
  await expect(addRepo.pickerEntry("from-worker")).toHaveAttribute("data-git", "true");
  await expect(addRepo.pickerEntry("no-remote")).toBeVisible();
  await addRepo.filter("from");
  await expect(addRepo.pickerEntry("no-remote")).toBeHidden();
  await addRepo.openFolder("from-worker");
  await expect(addRepo.crumbs().last()).toHaveText("from-worker");
  await addRepo.useCurrentFolder();
  await expect(addRepo.previewUrl()).toHaveText(origin);
  await expect(addRepo.previewBranch()).toHaveText("main");
  await expect(addRepo.rootConfirmation()).toBeVisible();
  await addRepo.confirmRoot();
  await expect(addRepo.closed()).toBeHidden();

  // The repo is named after its remote, not the folder.
  const repo = await findRepo(server.url, "from-worker-origin");
  expect(repo?.remoteUrl).toBe(origin);
  await settingsPage.openDialog("repos");
  await expect(settingsPage.repoUrl("from-worker-origin")).toContainText(origin);
  await expect(settingsPage.repoBranch("from-worker-origin")).toContainText("main");
  // The dialog covers the page: the only Add repo buttons left would be Settings', and it has none.
  await expect(settingsPage.dialogAddRepoButtons()).toHaveCount(0);
});

test("a worker folder with no remote says it stays on that worker", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  const addRepo = new AddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseWorker(hostId);
  await addRepo.openFolder("no-remote");
  await addRepo.useCurrentFolder();
  await expect(addRepo.previewLocalOnly()).toBeVisible();
});

test("By URL shows the remote's default branch and stores the repo with it", async ({ page }) => {
  const remotes = tmpDir("band-e2e-addrepo-remotes-");
  const { origin } = seedRepo(remotes, "by-url", remotes);
  // The remote's default branch is not main, so the stored branch must come from the remote.
  git(remotes, ["--git-dir", origin, "branch", "-m", "main", "trunk"], remotes);
  git(remotes, ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/trunk"], remotes);

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  const addRepo = new AddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseUrl();
  await addRepo.fillUrl(origin);
  await expect(addRepo.resolvedBranch()).toHaveText("trunk");
  await addRepo.addByUrl(origin);
  await expect(addRepo.closed()).toBeHidden();
  const repo = await findRepo(server.url, "by-url-origin");
  expect(repo?.remoteUrl).toBe(origin);
  expect(repo?.defaultBranch).toBe("trunk");
});

test("a repo added from the Repos panel under a label filter gets that label", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await worktreePage.selectLabelFilter(LABEL);
  const addRepo = new AddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseUrl();
  await addRepo.addByUrl(bareRemote("labelled-origin"), "main");
  await expect(addRepo.closed()).toBeHidden();
  // Its label keeps it in the filtered list.
  expect((await findRepo(server.url, "labelled-origin"))?.label).toBe(LABEL);
});

test("Settings > Repos removes a repo that has no worktrees", async ({ page }) => {
  await trpc(server.url, "repos.addByUrl", {
    remoteUrl: bareRemote("registry-loose"),
    defaultBranch: "main",
  });

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("repos");
  await expect(settingsPage.repoRow("registry-loose")).toHaveAttribute("data-in-use", "false");
  await settingsPage.removeRepo("registry-loose");
  await expect(settingsPage.repoRow("registry-loose")).toHaveCount(0);
});

test.describe("with no worker online", () => {
  let bare: ServerHandle;
  let bareHome: string;

  test.beforeAll(async () => {
    bareHome = createTmpHome();
    seedSettings(bareHome, { tokenSecret: TOKEN });
    bare = await startServer({ tmpHome: bareHome, env: { BAND_LOCAL_HOST: "off" } });
  });

  test.afterAll(async () => {
    await bare.close();
    cleanupTmpHome(bareHome);
  });

  test("Add repo says so, links to Hosts and still adds a repo by URL", async ({ page }) => {
    const settingsPage = new SettingsPage(page, bare.url, TOKEN);
    await settingsPage.goto();
    const addRepo = new AddRepoPage(page);
    await addRepo.open();
    await expect(addRepo.noHostsNotice()).toBeVisible();
    await expect(addRepo.openHostsButton()).toBeVisible();
    await expect(addRepo.nativePicker()).toHaveCount(0);

    const origin = bareRemote("by-url-origin");
    await addRepo.chooseUrlFromNotice();
    await addRepo.addByUrl(origin, "main");
    await expect(addRepo.closed()).toBeHidden();
    const repo = await findRepo(bare.url, "by-url-origin");
    expect(repo?.remoteUrl).toBe(origin);
    expect(repo?.defaultBranch).toBe("main");
  });
});
