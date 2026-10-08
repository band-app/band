/**
 * Adding a repo outside a project, from the sidebar's Repos panel: the repo belongs to no project.
 * Settings > Repos has no Add repo and lists every repo with the projects that use it. A second
 * server runs with the hub's local host off and no worker, so a project's Add repo shows the
 * "no worker online" notice and still adds a repo by URL. Real hub, local bare repos as remotes,
 * never the real `~/.band`. `project-add-repo.spec.ts` covers the worker folder picker.
 */

import { mkdtempSync, realpathSync } from "node:fs";
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
import { ProjectAddRepoPage } from "./pages/ProjectAddRepoPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1280, height: 900 } });

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

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

test("the Repos panel adds a repo in no project, and Settings > Repos lists it with no Add repo", async ({
  page,
}) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await projects.goto();
  // With no project there is no project list, and the Repos panel still offers Add repo.
  await expect(projects.items()).toHaveCount(0);
  const addRepo = new ProjectAddRepoPage(page);
  await addRepo.openFromReposPanel();
  const origin = bareRemote("registry-origin");
  await addRepo.chooseUrl();
  await addRepo.addByUrl(origin, "main");
  await expect(addRepo.closed()).toBeHidden();
  const repo = await findRepo(server.url, "registry-origin");
  expect(repo?.remoteUrl).toBe(origin);

  await settingsPage.openDialog("repos");
  await expect(settingsPage.repoRow("registry-origin")).toBeVisible();
  await expect(settingsPage.repoProjects("registry-origin")).toHaveAttribute("data-projects", "");
  // The dialog covers the page: the only Add repo buttons left would be Settings', and it has none.
  await expect(settingsPage.dialogAddRepoButtons()).toHaveCount(0);
});

test("a repo added from the Repos panel under a label filter gets that label", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await worktreePage.selectLabelFilter(LABEL);
  const addRepo = new ProjectAddRepoPage(page);
  await addRepo.openFromReposPanel();
  await addRepo.chooseUrl();
  await addRepo.addByUrl(bareRemote("labelled-origin"), "main");
  await expect(addRepo.closed()).toBeHidden();
  // Its label keeps it in the filtered list.
  expect((await findRepo(server.url, "labelled-origin"))?.label).toBe(LABEL);
});

test("Settings > Repos removes a repo no project uses and keeps one a project uses", async ({
  page,
}) => {
  await trpc(server.url, "repos.addByUrl", {
    remoteUrl: bareRemote("registry-loose"),
    defaultBranch: "main",
  });
  await trpc(server.url, "repos.addByUrl", {
    remoteUrl: bareRemote("registry-shared"),
    defaultBranch: "main",
  });
  await trpc(server.url, "projects.create", { name: "registry-user" });
  await trpc(server.url, "projects.addRepo", { project: "registry-user", repo: "registry-shared" });

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("repos");
  await expect(settingsPage.repoRow("registry-shared")).toHaveAttribute("data-in-use", "true");
  await expect(settingsPage.repoRemoveButton("registry-shared")).toBeDisabled();

  await expect(settingsPage.repoRow("registry-loose")).toHaveAttribute("data-in-use", "false");
  await settingsPage.removeRepo("registry-loose");
  await expect(settingsPage.repoRow("registry-loose")).toHaveCount(0);
  await expect(settingsPage.repoRow("registry-shared")).toBeVisible();
});

test.describe("with no worker online", () => {
  let bare: ServerHandle;
  let bareHome: string;

  test.beforeAll(async () => {
    bareHome = createTmpHome();
    seedSettings(bareHome, { tokenSecret: TOKEN });
    bare = await startServer({ tmpHome: bareHome, env: { BAND_LOCAL_HOST: "off" } });
    await trpc(bare.url, "projects.create", { name: "no-workers" });
  });

  test.afterAll(async () => {
    await bare.close();
    cleanupTmpHome(bareHome);
  });

  test("a project's Add repo says so, links to Hosts and still adds a repo by URL", async ({
    page,
  }) => {
    const projects = new ProjectsPage(page, bare.url, TOKEN);
    await projects.gotoProject("no-workers");
    const addRepo = new ProjectAddRepoPage(page);
    await addRepo.open();
    await expect(addRepo.noHostsNotice()).toBeVisible();
    await expect(addRepo.openHostsButton()).toBeVisible();
    await expect(addRepo.nativePicker()).toHaveCount(0);

    const origin = bareRemote("by-url-origin");
    await addRepo.chooseUrlFromNotice();
    await addRepo.addByUrl(origin, "main");
    await expect(addRepo.closed()).toBeHidden();
    await expect(addRepo.repoUrl("by-url-origin")).toHaveAttribute("data-url", origin);
    const repo = await findRepo(bare.url, "by-url-origin");
    expect(repo?.remoteUrl).toBe(origin);
    expect(repo?.defaultBranch).toBe("main");
  });
});
