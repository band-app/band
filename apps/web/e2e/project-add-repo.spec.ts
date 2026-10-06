/**
 * Add repo inside a project (repos by URL). The user path: add a worker from Settings > Hosts, run
 * the real `band-worker` binary with a temp HOME, open a project, pick a git folder in the worker's
 * home through the folder picker, confirm that it is outside the worker's roots, and see the repo
 * in the project with the URL the worker read from its `origin`. A second case adds a repo by URL
 * with a local bare repository as the remote. Real hub and worker, temp dirs, never the real
 * `~/.band`. `apps/hub/tests/repos-by-url.test.ts` covers the hub side.
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
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";

test.use({ viewport: { width: 1280, height: 900 } });

const TOKEN = "e2e-project-add-repo-token";

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle | undefined;
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** A git repository with one commit whose `origin` is a bare repository next to it. */
function seedRepoWithOrigin(
  parent: string,
  name: string,
  home: string,
): { path: string; origin: string } {
  const origin = join(parent, `${name}-origin.git`);
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  git(parent, ["init", "--bare", "-b", "main", origin], home);
  git(path, ["init", "-b", "main"], home);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  git(path, ["add", "."], home);
  git(path, ["commit", "-m", "seed"], home);
  git(path, ["remote", "add", "origin", origin], home);
  git(path, ["push", "origin", "main"], home);
  return { path, origin };
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

test("adds a repo from a worker folder outside its roots after a confirmation, and one by URL", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  await settingsPage.addWorker("picker-box", "");
  const env = parseWorkerCommand(await settingsPage.readWorkerCommand());
  const hostId = env.BAND_WORKER_ID;

  const workerHome = tmpDir("band-e2e-addrepo-home-");
  const root = tmpDir("band-e2e-addrepo-root-");
  const remotes = tmpDir("band-e2e-addrepo-remotes-");
  // A checkout in the worker's home, outside its only root.
  const { path: checkout, origin } = seedRepoWithOrigin(workerHome, "from-worker", workerHome);
  const { origin: urlOrigin } = seedRepoWithOrigin(remotes, "by-url", workerHome);
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

  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.create({ name: "picker-project", repos: [] });

  const addRepo = new ProjectAddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseWorker(hostId);
  // The picker starts in the worker's home and lists the folder with the checkout.
  await expect(addRepo.pickerEntry("from-worker")).toBeVisible();
  await expect(addRepo.pickerEntry("from-worker")).toHaveAttribute("data-git", "true");
  await addRepo.openFolder("from-worker");
  await addRepo.useCurrentFolder();
  await expect(addRepo.rootConfirmation()).toBeVisible();
  await addRepo.confirmRoot();
  await expect(addRepo.repo("from-worker-origin")).toBeVisible();
  await expect(addRepo.repoUrl("from-worker-origin")).toHaveText(origin);
  expect(checkout).toContain("from-worker");
  // The repo is named after its remote, not the folder.

  await addRepo.open();
  await addRepo.chooseUrl();
  await addRepo.addByUrl(urlOrigin, "main");
  await expect(addRepo.repo("by-url-origin")).toBeVisible();
  await expect(addRepo.repoUrl("by-url-origin")).toHaveText(urlOrigin);
});
