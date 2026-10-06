/**
 * Projects (plan step 6.1): the Projects dialog opened from the sidebar. The hub is the
 * production bundle with a temp BAND_HOME, and the two repos are real git repositories.
 * The context repo is checked through the context browser the project's detail links to.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
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
import { ProjectsPage } from "./pages/ProjectsPage";

test.use({ viewport: { width: 1280, height: 900 } });

const TOKEN = "e2e-projects-token";
const API = "api";
const CLIENT = "client";
const BRANCH = "feat-shared";

let server: ServerHandle;
let tmpHome: string;

async function trpc<T>(procedure: string, input: unknown): Promise<T> {
  const res = await fetch(`${server.url}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`${procedure}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

function seedRepo(name: string): string {
  const path = join(tmpHome, name);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  git(path, ["add", "."], tmpHome);
  git(path, ["commit", "-m", "seed"], tmpHome);
  return path;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const apiPath = seedRepo(API);
  const clientPath = seedRepo(CLIENT);
  const worktreePath = join(tmpHome, `${API}-${BRANCH}`);
  git(apiPath, ["worktree", "add", "-b", BRANCH, worktreePath], tmpHome);
  seedState(tmpHome, {
    repos: [
      {
        name: API,
        path: apiPath,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: apiPath },
          { branch: BRANCH, path: worktreePath },
        ],
      },
      {
        name: CLIENT,
        path: clientPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: clientPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("creates a project with two repos, lists it and gives it a scaffolded context repo", async ({
  page,
}) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await expect(projects.emptyState()).toBeVisible();

  await projects.create({
    name: "checkout",
    description: "Rework the checkout flow",
    repos: [
      { repo: API, role: "api" },
      { repo: CLIENT, role: "client" },
    ],
  });
  await expect(projects.repos()).toHaveCount(2);
  await expect(projects.repo(API)).toHaveAttribute("data-role", "api");
  await expect(projects.repo(CLIENT)).toHaveAttribute("data-role", "client");

  await projects.back();
  await expect(projects.item("checkout")).toHaveAttribute("data-repo-count", "2");
  await expect(projects.item("checkout")).toContainText("Rework the checkout flow");

  await projects.openProject("checkout");
  const context = await projects.openContext();
  await context.selectContext("checkout");
  await expect(context.treeFile("notes.md")).toBeVisible();
});

test("the coordinator model defaults to opus and can be changed", async ({ page }) => {
  await trpc("projects.create", { name: "billing", repos: [{ repo: API }] });
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("billing");
  await expect(projects.modelSelect()).toHaveValue("opus");

  await projects.chooseModel("sonnet");
  await expect(projects.modelSelect()).toHaveValue("sonnet");
  await projects.back();
  await expect(projects.item("billing")).toHaveAttribute("data-model", "sonnet");
});

test("refuses to remove a repo that still has a worktree in the project", async ({ page }) => {
  await trpc("projects.create", { name: "search", repos: [{ repo: API }, { repo: CLIENT }] });
  await trpc("projects.attachWorktree", {
    project: "search",
    worktreeId: toWorktreeId(API, BRANCH),
  });
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("search");
  await expect(projects.worktreeGroup(API)).toContainText(BRANCH);

  await projects.removeRepo(API);
  await expect(projects.error()).toContainText(BRANCH);
  await expect(projects.repo(API)).toBeVisible();

  await projects.removeRepo(CLIENT);
  await expect(projects.repo(CLIENT)).toHaveCount(0);
});

test("a new project starts its coordinator and shows the default policy and model lanes", async ({
  page,
}) => {
  await trpc("projects.create", { name: "ledger", repos: [{ repo: CLIENT }] });
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("ledger");

  await expect(projects.coordinator()).toHaveAttribute("data-state", "started");
  await expect(projects.coordinatorChat()).not.toBeEmpty();
  // The folder section lists the project's repo as a checkout of its default branch.
  await expect(projects.folder()).toBeVisible();
  await expect(projects.autonomy()).toHaveValue("steer");
  await expect(projects.lane("coordinator")).toHaveValue("opus");
  await expect(projects.lane("worker")).toHaveValue("sonnet");
  await expect(projects.lane("reviewer")).toHaveValue("sonnet");
  await expect(projects.maxConcurrent()).toHaveValue("");
  await expect(projects.isolationFloor()).toHaveValue("worktree");
});

test("edits the autonomy and the policy limits and keeps them after a reload", async ({ page }) => {
  await trpc("projects.create", { name: "payments", repos: [{ repo: API }] });
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("payments");

  await projects.chooseAutonomy("observe");
  await projects.savePolicy({
    maxConcurrent: "2",
    budget: "25",
    isolationFloor: "container",
    workerModel: "haiku",
  });
  await expect(projects.maxConcurrent()).toHaveValue("2");

  await projects.goto();
  await projects.open();
  await projects.openProject("payments");
  await expect(projects.autonomy()).toHaveValue("observe");
  await expect(projects.maxConcurrent()).toHaveValue("2");
  await expect(projects.budget()).toHaveValue("25");
  await expect(projects.isolationFloor()).toHaveValue("container");
  await expect(projects.lane("worker")).toHaveValue("haiku");
  await expect(projects.lane("reviewer")).toHaveValue("sonnet");
});
