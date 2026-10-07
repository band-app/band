/**
 * The task UI (plan step T.3): projects with their coordinator and tasks in the sidebar, the New
 * task dialog, the task view with a section per member repo (Changes, PR, CI), Add repo and Remove
 * repo, and terminals that open in the task folder with a member picker. A real hub with the
 * scripted ACP stub as the agent, local bare repositories as remotes, a temp BAND_HOME.
 * `apps/hub/tests/project-tasks.test.ts` covers the API.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { acpStubEnv } from "./helpers/acp-stub";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { TaskPage } from "./pages/TaskPage";

test.use({ viewport: { width: 1280, height: 1000 } });
test.describe.configure({ mode: "serial" });

const TOKEN = "e2e-task-view-token";
const API = "api";
const CLIENT = "client";
const PROJECT = "shop";

let server: ServerHandle;
let tmpHome: string;

const remoteOf = (name: string) => join(tmpHome, "remotes", `${name}.git`);
const taskFolder = (task: string) =>
  join(realpathSync(tmpHome), ".band", "projects", PROJECT, "tasks", task);

function seedRepo(name: string) {
  const path = join(tmpHome, name);
  mkdirSync(join(tmpHome, "remotes"), { recursive: true });
  gitInHome(tmpHome, ["init", "-q", "--bare", "-b", "main", remoteOf(name)], tmpHome);
  mkdirSync(path, { recursive: true });
  gitInHome(path, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  gitInHome(path, ["add", "-A"], tmpHome);
  gitInHome(path, ["commit", "-m", "init"], tmpHome);
  gitInHome(path, ["remote", "add", "origin", remoteOf(name)], tmpHome);
  gitInHome(path, ["push", "-q", "-u", "origin", "main"], tmpHome);
  return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
}

async function trpc<T>(procedure: string, input: unknown, query = false): Promise<T> {
  const res = query
    ? await fetch(
        `${server.url}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`,
        {
          headers: { Cookie: `band_token=${TOKEN}` },
        },
      )
    : await fetch(`${server.url}/trpc/${procedure}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
        body: JSON.stringify(input),
      });
  if (!res.ok) throw new Error(`${procedure}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

interface TaskData {
  task: { id: string; members: Array<{ repo: string; path: string; worktreeId: string }> };
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { repos: [seedRepo(API), seedRepo(CLIENT)] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
  await trpc("projects.create", { name: PROJECT, repos: [{ repo: API }, { repo: CLIENT }] });
  await trpc("projects.syncFolder", { project: PROJECT });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("creates a task with two repos from the New task dialog and shows its view (S1)", async ({
  page,
}) => {
  const tasks = new TaskPage(page, server.url, TOKEN);
  await tasks.goto();
  await tasks.createTask(PROJECT, {
    name: "checkout-flow",
    repos: [API, CLIENT],
    brief: "Build the checkout flow.\n",
  });
  await expect(page).toHaveURL(/\/task\/tsk-/);
  await expect(tasks.members()).toHaveCount(2);
  await expect(tasks.member(API)).toBeVisible();
  await expect(tasks.member(CLIENT)).toBeVisible();
  await expect(tasks.chat()).toBeVisible();
  await expect(tasks.header()).toContainText("checkout-flow");
  await expect(tasks.folder()).toHaveText(taskFolder("checkout-flow"));
  expect(existsSync(join(taskFolder("checkout-flow"), "BRIEF.md"))).toBe(true);
  expect(existsSync(join(taskFolder("checkout-flow"), API, ".git"))).toBe(true);
  expect(existsSync(join(taskFolder("checkout-flow"), CLIENT, ".git"))).toBe(true);
});

test("shows a commit made in a member worktree in that member's Changes (S2)", async ({ page }) => {
  const { task } = await trpc<TaskData>(
    "projectTasks.get",
    { task: "checkout-flow", project: PROJECT },
    true,
  );
  const api = task.members.find((m) => m.repo === API);
  if (!api) throw new Error("the task has no api member");
  writeFileSync(join(api.path, "checkout.ts"), 'export const checkout = "done";\n');
  gitInHome(api.path, ["add", "-A"], tmpHome);
  gitInHome(api.path, ["commit", "-m", "add checkout"], tmpHome);

  const tasks = new TaskPage(page, server.url, TOKEN);
  await tasks.goto("/");
  await tasks.openFromSidebar(PROJECT, "checkout-flow");
  await expect(tasks.memberDiff(API, "checkout.ts")).toContainText(
    'export const checkout = "done"',
  );
  await expect(tasks.memberDiff(CLIENT, "checkout.ts")).toHaveCount(0);
});

test("adds a repo to a task and shows the refusal when removing a member with commits (S3)", async ({
  page,
}) => {
  await trpc("projectTasks.create", {
    project: PROJECT,
    branch: "solo",
    brief: "",
    repos: [{ repo: API }],
    start: false,
  });
  const tasks = new TaskPage(page, server.url, TOKEN);
  await tasks.goto("/");
  await tasks.openFromSidebar(PROJECT, "solo");
  await expect(tasks.members()).toHaveCount(1);

  await tasks.addRepo(CLIENT);
  await expect(tasks.members()).toHaveCount(2);
  await expect(tasks.member(CLIENT)).toBeVisible();

  const { task } = await trpc<TaskData>(
    "projectTasks.get",
    { task: "solo", project: PROJECT },
    true,
  );
  const client = task.members.find((m) => m.repo === CLIENT);
  if (!client) throw new Error("the task has no client member");
  writeFileSync(join(client.path, "work.ts"), "export {};\n");
  gitInHome(client.path, ["add", "-A"], tmpHome);
  gitInHome(client.path, ["commit", "-m", "work"], tmpHome);

  await tasks.removeRepo(CLIENT);
  await expect(tasks.removeError(CLIENT)).toContainText(/not on/);
  await expect(tasks.member(CLIENT)).toBeVisible();

  await tasks.removeRepo(API);
  await expect(tasks.member(API)).toHaveCount(0);
});

test("opens a terminal in the task folder and in a member worktree (S4)", async ({ page }) => {
  const tasks = new TaskPage(page, server.url, TOKEN);
  await tasks.goto("/");
  await tasks.openFromSidebar(PROJECT, "checkout-flow");

  const folderTerminal = await tasks.openTerminal();
  await expect(folderTerminal).toHaveAttribute("data-cwd", taskFolder("checkout-flow"));
  await tasks.runInTerminal(folderTerminal, "echo cwd=$(pwd -P)");
  await expect
    .poll(() => tasks.terminalText(folderTerminal))
    .toContain(`cwd=${taskFolder("checkout-flow")}`);

  const memberTerminal = await tasks.openTerminal(CLIENT);
  await expect(memberTerminal).toHaveAttribute(
    "data-cwd",
    join(taskFolder("checkout-flow"), CLIENT),
  );
  await tasks.runInTerminal(memberTerminal, "echo cwd=$(pwd -P)");
  await expect
    .poll(() => tasks.terminalText(memberTerminal))
    .toContain(`cwd=${join(taskFolder("checkout-flow"), CLIENT)}`);
});

test("lists projects with coordinator and tasks, and sends an old worktree URL to its task (S5)", async ({
  page,
}) => {
  const tasks = new TaskPage(page, server.url, TOKEN);
  await tasks.goto("/");
  await expect(tasks.project(PROJECT)).toBeVisible();
  await expect(tasks.project("personal")).toBeVisible();
  await expect(tasks.coordinatorRow(PROJECT)).toBeVisible();
  await expect(tasks.sidebarTask(PROJECT, "checkout-flow")).toBeVisible();

  const { task } = await trpc<TaskData>(
    "projectTasks.get",
    { task: "checkout-flow", project: PROJECT },
    true,
  );
  const member = task.members[0];
  await tasks.goto(`/worktree/${encodeURIComponent(member.worktreeId)}`);
  await expect(page).toHaveURL(new RegExp(`/task/${task.id}`));
  await expect(tasks.root).toHaveAttribute("data-task", "checkout-flow");
});
