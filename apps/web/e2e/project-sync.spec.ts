/**
 * V2 of the projects redesign in the UI: a project's files sync between hosts on their own. The
 * coordinator runs on the hub's own host and a real `band-worker` holds a worktree of the project,
 * so both keep a copy of the project folder. A file saved in the project's view reaches the
 * worker's copy, and a file written in the worker's copy (as an agent there would) shows up in the
 * view's Explorer, with no push or pull anywhere. Real hub (production bundle, temp BAND_HOME, a
 * short BAND_CONTEXT_AUTOSYNC_MS), real worker with a temp HOME, real git with a local bare remote.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
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
  seedState,
  startServer,
} from "./helpers/server";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { ProjectsPage } from "./pages/ProjectsPage";

test.use({ viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial" });

const TOKEN = "e2e-project-sync-token";
const PROJECT = "synced";

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle | undefined;
let hubFolder = "";
let workerFolder = "";
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

async function trpc<T>(procedure: string, input?: unknown, method: "GET" | "POST" = "POST") {
  const url =
    method === "GET"
      ? `${server.url}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`
      : `${server.url}/trpc/${procedure}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    ...(method === "POST" ? { body: JSON.stringify(input ?? {}) } : {}),
  });
  if (!res.ok) throw new Error(`${procedure}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // One repo with a bare origin. The hub and the worker each have a clone.
  const origin = join(tmpHome, "api-origin.git");
  const hubClone = join(tmpHome, "api");
  mkdirSync(hubClone, { recursive: true });
  git(hubClone, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(hubClone, "README.md"), "# api\n");
  git(hubClone, ["add", "."], tmpHome);
  git(hubClone, ["commit", "-m", "seed"], tmpHome);
  git(tmpHome, ["init", "--bare", "-b", "main", origin], tmpHome);
  git(hubClone, ["remote", "add", "origin", origin], tmpHome);
  git(hubClone, ["push", "-u", "origin", "main"], tmpHome);
  seedState(tmpHome, {
    repos: [
      {
        name: "api",
        path: hubClone,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubClone }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome,
    env: { ...acpStubEnv(tmpHome), BAND_CONTEXT_AUTOSYNC_MS: "500" },
  });

  const workerHome = tmpDir("band-e2e-sync-home-");
  const root = tmpDir("band-e2e-sync-root-");
  git(root, ["clone", origin, "api"], workerHome);
  const issued = await trpc<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "sync-box",
  });
  worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: issued.hostId,
    },
    root,
    stateDir: tmpDir("band-e2e-sync-state-"),
    home: workerHome,
  });
  await expect
    .poll(
      async () =>
        (
          await trpc<{ hosts: Array<{ id: string; status: string }> }>(
            "hosts.list",
            undefined,
            "GET",
          )
        ).hosts.find((h) => h.id === issued.hostId)?.status,
      { timeout: 20_000 },
    )
    .toBe("online");

  // The coordinator runs on the hub's own host. The worker does project work in a worktree.
  await trpc("projects.create", { name: PROJECT, repos: [{ repo: "api" }] });
  await trpc("worktrees.create", {
    repo: "api",
    branch: "feat-remote",
    hostId: issued.hostId,
    hostRepoPath: join(root, "api"),
    projectId: PROJECT,
  });
  hubFolder = (
    await trpc<{ folder: { folder: string } }>("projects.prepareFolder", { project: PROJECT })
  ).folder.folder;
  workerFolder = join(workerHome, ".band", "projects", PROJECT);
  // A file to edit, written in the hub's copy. Its arrival on the worker is the sync at work.
  writeFileSync(join(hubFolder, "plan.txt"), "draft\n");
  await expect
    .poll(() => readIfExists(join(workerFolder, "plan.txt")), { timeout: 30_000 })
    .toBe("draft\n");
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

test("a file saved in the project's view reaches the worker's copy", async ({ page }) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject(PROJECT);

  const editor = await projects.openFile("plan.txt");
  await editor.typeAtStart("reviewed ");
  await editor.saveWithShortcut();
  await editor.expectSaved();

  await expect
    .poll(() => readIfExists(join(workerFolder, "plan.txt")), { timeout: 30_000 })
    .toBe("reviewed draft\n");
});

test("a file written in the worker's copy shows up in the project's view", async ({ page }) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject(PROJECT);
  await projects.showExplorer();

  writeFileSync(join(workerFolder, "from-worker.txt"), "an agent on the worker\n");

  await expect(projects.explorerEntry("from-worker.txt")).toBeVisible({ timeout: 30_000 });
  const editor = await projects.openFile("from-worker.txt");
  await editor.expectContent("an agent on the worker");
});
