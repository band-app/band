/**
 * Add repo from the Repos list in the sidebar (not from a project). The dialog is the same one the
 * project screen uses: a worker's folder picker or a remote URL. Real hub, the real `band-worker`
 * binary with a temp HOME, never the real `~/.band`. A second server runs with the hub's local host
 * off and no worker, to cover the "no worker online" notice.
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
import { ProjectAddRepoPage } from "./pages/ProjectAddRepoPage";
import { SettingsPage } from "./pages/SettingsPage";

test.use({ viewport: { width: 1280, height: 900 } });

const TOKEN = "e2e-repos-add-repo-token";

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle | undefined;
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

async function findRepo(
  url: string,
  name: string,
): Promise<{ name: string; remoteUrl?: string; defaultBranch?: string } | undefined> {
  const res = await fetch(`${url}/trpc/repos.list`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await res.json();
  return body.result.data.repos.find((r: { name: string }) => r.name === name);
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

test("Repos > Add repo adds a git checkout from a worker with its remote URL and hides the native picker", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  await settingsPage.addWorker("repos-box", "");
  const env = parseWorkerCommand(await settingsPage.readWorkerCommand());
  const hostId = env.BAND_WORKER_ID;

  const workerHome = tmpDir("band-e2e-reposadd-home-");
  const root = tmpDir("band-e2e-reposadd-root-");
  const origin = join(workerHome, "listed-origin.git");
  const checkout = join(workerHome, "listed");
  mkdirSync(checkout, { recursive: true });
  git(workerHome, ["init", "--bare", "-b", "main", origin], workerHome);
  git(checkout, ["init", "-b", "main"], workerHome);
  writeFileSync(join(checkout, "README.md"), "# listed\n");
  git(checkout, ["add", "."], workerHome);
  git(checkout, ["commit", "-m", "seed"], workerHome);
  git(checkout, ["remote", "add", "origin", origin], workerHome);
  git(checkout, ["push", "origin", "main"], workerHome);
  worker = startWorker({
    env: {
      BAND_HUB_URL: env.BAND_HUB_URL,
      BAND_BOOTSTRAP_TOKEN: env.BAND_BOOTSTRAP_TOKEN,
      BAND_WORKER_ID: hostId,
    },
    root,
    stateDir: tmpDir("band-e2e-reposadd-state-"),
    home: workerHome,
  });
  await expect(settingsPage.hostRow(hostId)).toHaveAttribute("data-status", "online", {
    timeout: 20_000,
  });

  await settingsPage.goto();
  const addRepo = new ProjectAddRepoPage(page);
  await addRepo.openFromRepoList();
  await addRepo.chooseWorker(hostId);
  await expect(addRepo.pickerEntry("listed")).toHaveAttribute("data-git", "true");
  await expect(addRepo.nativePicker()).toHaveCount(0);
  await addRepo.openFolder("listed");
  await addRepo.useCurrentFolder();
  await expect(addRepo.rootConfirmation()).toBeVisible();
  await addRepo.confirmRoot();
  await expect(addRepo.closed()).toBeHidden();

  const repo = await findRepo(server.url, "listed-origin");
  expect(repo).toBeDefined();
  expect(repo?.remoteUrl).toBe(origin);
  expect(repo?.defaultBranch).toBe("main");
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

  test("the dialog says so and still adds a repo by URL", async ({ page }) => {
    const addRepo = new ProjectAddRepoPage(page);
    await addRepo.gotoAndOpenFromRepoList(bare.url, TOKEN);
    await expect(addRepo.noHostsNotice()).toBeVisible();
    await expect(addRepo.nativePicker()).toHaveCount(0);

    const remotes = tmpDir("band-e2e-reposadd-remotes-");
    const urlOrigin = join(remotes, "by-url-origin.git");
    git(remotes, ["init", "--bare", "-b", "main", urlOrigin], remotes);
    await addRepo.chooseUrlFromNotice();
    await addRepo.addByUrl(urlOrigin, "main");
    await expect(addRepo.closed()).toBeHidden();
    const repo = await findRepo(bare.url, "by-url-origin");
    expect(repo).toBeDefined();
    expect(repo?.remoteUrl).toBe(urlOrigin);
    expect(repo?.defaultBranch).toBe("main");
  });
});
