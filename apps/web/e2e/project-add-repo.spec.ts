/**
 * Add repo inside a project (repos by URL). The user path: add a worker from Settings > Hosts, run
 * the real `band-worker` binary with a temp HOME, create a project and, in the same flow, pick a
 * git folder in the worker's home through the folder picker, read its remote URL and branch in the
 * preview, confirm that it is outside the worker's roots, and land on the project page with the
 * repo and the coordinator chat. The coordinator then answers a message through the scripted ACP
 * stub. Other cases: a folder with no remote says it stays on that worker, and By URL shows the
 * default branch the hub read from a local bare remote and stores it. Real hub and worker, temp
 * dirs, never the real `~/.band`. `apps/hub/tests/repos-by-url.test.ts` covers the hub side.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { acpStubEnv } from "./helpers/acp-stub";
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
import { ChatPanePage } from "./pages/ChatPanePage";
import { ProjectAddRepoPage } from "./pages/ProjectAddRepoPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";

test.use({ viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial" });

const TOKEN = "e2e-project-add-repo-token";
const REPLY = "Coordinator here. I read the charter and the repos.";

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle | undefined;
let hostId = "";
let workerHome = "";
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

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

async function findRepo(
  name: string,
): Promise<{ name: string; remoteUrl?: string; defaultBranch?: string } | undefined> {
  const res = await fetch(`${server.url}/trpc/repos.list`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await res.json();
  return body.result.data.repos.find((r: { name: string }) => r.name === name);
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [{ match: "who are you", steps: [{ say: REPLY }] }, { steps: [{ say: "Ready." }] }],
    }),
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

test("creates a project with a repo from a worker folder, then talks to its coordinator", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  await settingsPage.addWorker("picker-box", "");
  const env = parseWorkerCommand(await settingsPage.readWorkerCommand());
  hostId = env.BAND_WORKER_ID;

  workerHome = tmpDir("band-e2e-addrepo-home-");
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

  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.openCreateFlow();
  await projects.fillName("picker-project", "Repos from a worker");
  await projects.submitName();

  const addRepo = new ProjectAddRepoPage(page, "create-flow");
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
  // The repo is named after its remote, not the folder.
  await expect(projects.addedRepo("from-worker-origin")).toBeVisible();
  await projects.reposNext();
  await projects.finish("picker-project");

  await expect(projects.chat()).toBeVisible({ timeout: 20_000 });
  await projects.showTab("repos");
  await expect(addRepo.repoUrl("from-worker-origin")).toHaveAttribute("data-url", origin);
  await expect(addRepo.repoBranch("from-worker-origin")).toContainText("main");

  // The coordinator's chat is the center of the project view.
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.typeMessage("who are you");
  await chat.submit();
  await expect(chat.userMessage("who are you")).toBeVisible();
  await expect(chat.assistantMessage(REPLY)).toBeVisible({ timeout: 20_000 });
});

test("a worker folder with no remote says it stays on that worker", async ({ page }) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject("picker-project");
  const addRepo = new ProjectAddRepoPage(page);
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

  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject("picker-project");
  const addRepo = new ProjectAddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseUrl();
  await addRepo.fillUrl(origin);
  await expect(addRepo.resolvedBranch()).toHaveText("trunk");
  await addRepo.addByUrl(origin);
  await expect(addRepo.closed()).toBeHidden();
  await expect(addRepo.repoUrl("by-url-origin")).toHaveAttribute("data-url", origin);
  await expect(addRepo.repoBranch("by-url-origin")).toContainText("trunk");
  const repo = await findRepo("by-url-origin");
  expect(repo?.remoteUrl).toBe(origin);
  expect(repo?.defaultBranch).toBe("trunk");
});
