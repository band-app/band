/**
 * Projects: the sidebar's projects list with each project's worktrees under it, the New project
 * flow, the project's folder view (`/project/<name>`: the coordinator chat in the center, the
 * folder's files in the Explorer and editor, a terminal in the folder, the Activity and Repos side
 * tabs and no Changes),
 * and project settings in the Settings dialog. The hub is the production bundle with a temp
 * BAND_HOME, and the two repos are real git repositories.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { ChatPanePage } from "./pages/ChatPanePage";
import { MobileLayoutPage } from "./pages/MobileLayoutPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ToolbarPage } from "./pages/ToolbarPage";

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

test("creates a project with two repos and opens its folder view with the context files", async ({
  page,
}) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  // There is no default project: the sidebar starts empty.
  await expect(projects.items()).toHaveCount(0);

  await projects.create({
    name: "checkout",
    description: "Rework the checkout flow",
    repos: [
      { repo: API, role: "api" },
      { repo: CLIENT, role: "client" },
    ],
  });
  await expect(projects.itemOpen("checkout")).toHaveAttribute("aria-current", "page");
  await expect(projects.description()).toHaveText("Rework the checkout flow");
  // The folder is no git checkout of its own: no Changes tab.
  await expect(projects.changesTab()).toHaveCount(0);
  await projects.showTab("repos");
  await expect(projects.repos()).toHaveCount(2);
  await expect(projects.repo(API)).toHaveAttribute("data-role", "api");
  await expect(projects.repo(CLIENT)).toHaveAttribute("data-role", "client");

  // The Explorer lists the project folder: the scaffold of its context repo.
  await projects.showExplorer();
  await expect(projects.explorerEntry("notes.md")).toBeVisible();
  await expect(projects.explorerEntry("inbox")).toBeVisible();
});

test("opens a terminal in the project folder and edits a project file in the editor", async ({
  page,
}) => {
  const { project } = await trpc<{ project: { id: string } }>("projects.create", {
    name: "workbench",
  });
  const { folder } = await trpc<{ folder: { folder: string } }>("projects.prepareFolder", {
    project: "workbench",
  });
  writeFileSync(join(folder.folder, "plan.txt"), "draft\n");
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject("workbench");

  const terminal = projects.terminal(project.id);
  await expect(terminal.wrapper).toBeVisible();
  await terminal.typeLine('echo "cwd=$(basename "$(dirname "$PWD")")/$(basename "$PWD")"');
  await expect.poll(() => terminal.readScreenText()).toContain("cwd=projects/workbench");

  const editor = await projects.openFile("plan.txt");
  await editor.typeAtStart("reviewed ");
  await editor.saveWithShortcut();
  await editor.expectSaved();
  await expect
    .poll(() => readFileSync(join(folder.folder, "plan.txt"), "utf8"))
    .toBe("reviewed draft\n");
});

test("the coordinator model defaults to opus and can be changed", async ({ page }) => {
  await trpc("projects.create", { name: "billing", repos: [{ repo: API }] });
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject("billing");
  await projects.openSettings();
  await expect(projects.lane("coordinator")).toHaveValue("opus");

  await projects.savePolicy({ coordinatorModel: "sonnet" });
  await projects.gotoProject("billing");
  await projects.openSettings();
  await expect(projects.lane("coordinator")).toHaveValue("sonnet");
});

test("refuses to remove a repo that still has a worktree in the project", async ({ page }) => {
  await trpc("projects.create", { name: "search", repos: [{ repo: API }, { repo: CLIENT }] });
  await trpc("projects.attachWorktree", {
    project: "search",
    worktreeId: toWorktreeId(API, BRANCH),
  });
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.openProject("search");
  await projects.showTab("repos");
  await expect(projects.repos()).toHaveCount(2);

  await projects.removeRepo(API);
  await expect(projects.error()).toContainText(BRANCH);
  await expect(projects.repo(API)).toBeVisible();

  await projects.removeRepo(CLIENT);
  await expect(projects.repo(CLIENT)).toHaveCount(0);
});

test("a new project starts its coordinator, shows its chat in the center and the default policy", async ({
  page,
}) => {
  await trpc("projects.create", { name: "ledger", repos: [{ repo: CLIENT }] });
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject("ledger");

  await expect(projects.chat()).toBeVisible();
  // The charter names the project and its repos.
  const charter = await projects.openCharter();
  await expect(charter).toContainText("ledger");
  await expect(charter).toContainText(CLIENT);
  await projects.closeCharter();
  await expect(projects.coordinator()).toHaveAttribute("data-state", "started");
  await expect(projects.coordinatorChat()).not.toBeEmpty();
  // The folder section lists the project's repo as a checkout of its default branch.
  await projects.showTab("repos");
  await expect(projects.folder()).toBeVisible();
  await projects.openSettings();
  await expect(projects.autonomy()).toHaveValue("autonomous");
  await expect(projects.lane("coordinator")).toHaveValue("opus");
  await expect(projects.lane("worker")).toHaveValue("sonnet");
  await expect(projects.lane("reviewer")).toHaveValue("sonnet");
  await expect(projects.maxConcurrent()).toHaveValue("");
  await expect(projects.isolationFloor()).toHaveValue("worktree");
});

test("edits the autonomy and the policy limits and keeps them after a reload", async ({ page }) => {
  await trpc("projects.create", { name: "payments", repos: [{ repo: API }] });
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject("payments");
  await projects.openSettings();

  await projects.chooseAutonomy("observe");
  await projects.savePolicy({
    maxConcurrent: "2",
    budget: "25",
    isolationFloor: "container",
    workerModel: "haiku",
  });
  await expect(projects.maxConcurrent()).toHaveValue("2");

  await projects.gotoProject("payments");
  await projects.openSettings();
  await expect(projects.autonomy()).toHaveValue("observe");
  await expect(projects.maxConcurrent()).toHaveValue("2");
  await expect(projects.budget()).toHaveValue("25");
  await expect(projects.isolationFloor()).toHaveValue("container");
  await expect(projects.lane("worker")).toHaveValue("haiku");
  await expect(projects.lane("reviewer")).toHaveValue("sonnet");
});

test("renames a project from Settings, keeps its name as the id, and deletes it", async ({
  page,
}) => {
  await trpc("projects.create", { name: "inventory" });
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject("inventory");
  await projects.openSettings();

  await projects.rename("Stock and inventory");
  await projects.closeSettings();
  await expect(projects.itemName("inventory")).toHaveText("Stock and inventory");
  // The URL still takes the name.
  await projects.gotoProject("inventory");
  await expect(projects.itemOpen("inventory")).toHaveAttribute("aria-current", "page");
  await expect(projects.itemName("inventory")).toHaveText("Stock and inventory");

  await projects.openSettings();
  await projects.deleteProject();
  await expect(projects.item("inventory")).toHaveCount(0);
});

test("lists a project's worktrees under it, opens each in its worktree view, and keeps a collapsed project collapsed", async ({
  page,
}) => {
  await trpc("projects.create", { name: "sidebar-nav", repos: [{ repo: CLIENT }] });
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject("sidebar-nav");
  await expect(projects.sidebarWorktrees("sidebar-nav")).toHaveCount(0);

  // A worktree made from the project's row belongs to the project.
  await projects.openNewWorktree("sidebar-nav");
  await projects.createWorktree({ repo: CLIENT, branch: "sidebar-side" });
  const worktreeId = toWorktreeId(CLIENT, "sidebar-side");
  await projects.expectWorktreeView(worktreeId);
  await expect(projects.sidebarWorktrees("sidebar-nav")).toHaveCount(1);
  // The worktree view is the normal one, with Changes.
  await expect(projects.changesTab()).toBeVisible();

  await projects.openProject("sidebar-nav");
  await expect(projects.worktree(worktreeId)).toBeVisible();
  await projects.openSidebarWorktree("sidebar-nav", worktreeId);

  await projects.toggleItem("sidebar-nav");
  await expect(projects.sidebarWorktrees("sidebar-nav")).toHaveCount(0);
  await projects.gotoProject("sidebar-nav");
  await expect(projects.item("sidebar-nav")).toHaveAttribute("data-expanded", "false");
  await expect(projects.sidebarWorktrees("sidebar-nav")).toHaveCount(0);

  await projects.toggleItem("sidebar-nav");
  await expect(projects.sidebarWorktrees("sidebar-nav")).toHaveCount(1);
});

test("older links to a project's view land on /project/<name>, and its empty chat names the project", async ({
  page,
}) => {
  const { project } = await trpc<{ project: { id: string } }>("projects.create", {
    name: "atlas",
  });
  await trpc("projects.update", { project: project.id, title: "Atlas maps" });
  const projects = new ProjectsPage(page, server.url, TOKEN);

  await projects.gotoOldLink(`/project/${project.id}`);
  await projects.expectProjectUrl("atlas");
  await expect(projects.itemOpen("atlas")).toHaveAttribute("aria-current", "page");

  await projects.gotoOldLink(`/worktree/${encodeURIComponent(`project:${project.id}`)}`);
  await projects.expectProjectUrl("atlas");
  // A project with no repo has no coordinator, so open a chat of the project's view.
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.waitForReady();
  await expect(chat.emptyConversation).toContainText("Atlas maps");
  await expect(chat.emptyConversation).not.toContainText("project:");
});

test("an unknown project says so", async ({ page }) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoMissingProject("nope");
});

test("Settings lists every project under Projects and opens one's settings", async ({ page }) => {
  await trpc("projects.create", { name: "warehouse", repos: [{ repo: API }] });
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openDialog();
  await expect(settings.projectRow("warehouse")).toBeVisible();

  await settings.openProjectSettings("warehouse");
  await expect(settings.title()).toHaveText("warehouse");
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await expect(projects.autonomy()).toHaveValue("autonomous");
  await expect(projects.lane("worker")).toHaveValue("sonnet");
});

test("the toolbar's overflow menu has no Tasks entry", async ({ page }) => {
  const toolbar = new ToolbarPage(page, server.url, TOKEN);
  await toolbar.goto();
  await toolbar.openOverflowMenu();
  await expect(toolbar.overflowMenuItem("Cronjobs")).toBeVisible();
  await expect(toolbar.overflowMenuItem("Tasks")).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a project's view offers its side tabs as sheets and no Changes", async ({ page }) => {
    await trpc("projects.create", { name: "pocket", description: "Phone-sized project" });
    const projects = new ProjectsPage(page, server.url, TOKEN);
    await projects.gotoProjectOnPhone("pocket");
    const mobile = new MobileLayoutPage(page, server.url, TOKEN);
    await expect(mobile.headerWorktreeName).toHaveText("pocket");

    await mobile.openMenu();
    await expect(mobile.menuItem("explorer")).toBeVisible();
    await expect(mobile.menuItem("project-activity")).toBeVisible();
    await expect(mobile.menuItem("project-repos")).toBeVisible();
    await expect(mobile.menuItem("changes")).toHaveCount(0);
    await mobile.closeMenu();

    await mobile.openProjectSheet("activity");
    await expect(mobile.projectSheetBody("activity")).toContainText("Phone-sized project");
  });
});
