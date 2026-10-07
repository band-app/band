/**
 * The coordinator's code browser (plan step T.1b): the repos of a project with the Code view (tree,
 * file, search) and the Changes view (uncommitted diff with a commit box, unpushed commits with a
 * Push button, behind and diverged states) of each default-branch checkout. A real hub with the
 * scripted ACP stub as the coordinator's agent, local bare repositories as remotes, a temp
 * BAND_HOME. `apps/hub/tests/project-code-browser.test.ts` covers the API.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { acpStubEnv } from "./helpers/acp-stub";
import { git, gitCommit } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ProjectCodeBrowserPage } from "./pages/ProjectCodeBrowserPage";
import { ProjectsPage } from "./pages/ProjectsPage";

test.use({ viewport: { width: 1280, height: 1000 } });
test.describe.configure({ mode: "serial" });

const TOKEN = "e2e-code-browser-token";
const API = "api";
const CLIENT = "client";

let server: ServerHandle;
let tmpHome: string;

const remoteOf = (name: string) => join(tmpHome, "remotes", `${name}.git`);
const checkoutOf = (name: string) =>
  join(realpathSync(tmpHome), ".band", "projects", "shop", "repos", name);

function seedRepo(name: string) {
  const path = join(tmpHome, name);
  mkdirSync(join(tmpHome, "remotes"), { recursive: true });
  git(tmpHome, ["init", "-q", "--bare", "-b", "main", remoteOf(name)]);
  mkdirSync(join(path, "src"), { recursive: true });
  git(path, ["init", "-b", "main"]);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  writeFileSync(join(path, "src", "main.ts"), `export const repo = "${name}";\n`);
  gitCommit(path, "init");
  git(path, ["remote", "add", "origin", remoteOf(name)]);
  git(path, ["push", "-q", "-u", "origin", "main"]);
  return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
}

async function trpc<T>(procedure: string, input: unknown): Promise<T> {
  const res = await fetch(`${server.url}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`${procedure}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { repos: [seedRepo(API), seedRepo(CLIENT)] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
  await trpc("projects.create", { name: "shop", repos: [{ repo: API }, { repo: CLIENT }] });
  await trpc("projects.syncFolder", { project: "shop" });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function openBrowser(page: import("@playwright/test").Page) {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("shop");
  const browser = new ProjectCodeBrowserPage(page);
  await expect(browser.root).toBeVisible();
  return browser;
}

test("lists both repos and shows the tree and a file of the default-branch checkout (S1)", async ({
  page,
}) => {
  const browser = await openBrowser(page);
  await expect(browser.repoTabs()).toHaveText([API, CLIENT]);
  await browser.chooseRepo(API);
  await browser.openCode();
  await browser.openDir("src");
  await browser.openFile("src/main.ts");
  await expect(browser.viewer()).toContainText(`export const repo = "${API}"`);
  await browser.chooseRepo(CLIENT);
  await browser.openCode();
  await browser.openDir("src");
  await browser.openFile("src/main.ts");
  await expect(browser.viewer()).toContainText(`export const repo = "${CLIENT}"`);
});

test("searches inside the chosen checkout only (S3)", async ({ page }) => {
  const browser = await openBrowser(page);
  await browser.chooseRepo(API);
  await browser.openCode();
  await browser.search('repo = "client"');
  await expect(page.getByTestId("code-browser__results")).toContainText("No matches");
  await browser.search('repo = "api"');
  await expect(browser.results()).toHaveCount(1);
});

test("shows an edit made in a terminal, commits it and pushes it to origin/main (S2)", async ({
  page,
}) => {
  writeFileSync(join(checkoutOf(API), "src", "main.ts"), 'export const repo = "api-edited";\n');
  const browser = await openBrowser(page);
  await browser.chooseRepo(API);
  await browser.openChanges();
  await expect(browser.changedFile("src/main.ts")).toHaveAttribute("data-status", "modified");
  await expect(browser.diff()).toContainText("api-edited");

  await browser.commit("edit main from the browser");
  await expect(browser.unpushed()).toHaveCount(1);
  await expect(browser.unpushed()).toContainText("edit main from the browser");
  await expect(browser.changedFile("src/main.ts")).toHaveCount(0);

  await browser.push().click();
  await expect(browser.unpushed()).toHaveCount(0);
  await expect
    .poll(() =>
      execFileSync("git", ["log", "-1", "--format=%s", "main"], {
        cwd: remoteOf(API),
        encoding: "utf8",
      }).trim(),
    )
    .toBe("edit main from the browser");
});

test("offers Pull only when behind and no destructive action when diverged (S5)", async ({
  page,
}) => {
  const other = join(tmpHome, "teammate");
  git(tmpHome, ["clone", "-q", remoteOf(CLIENT), other]);
  writeFileSync(join(other, "theirs.txt"), "theirs\n");
  gitCommit(other, "their commit");
  git(other, ["push", "-q", "origin", "main"]);
  // The checkout learns of the commit with the next fetch, which the folder sync does without touching local work.
  writeFileSync(join(checkoutOf(CLIENT), "mine.txt"), "mine\n");
  gitCommit(checkoutOf(CLIENT), "my commit");
  await trpc("projects.syncFolder", { project: "shop" });

  const browser = await openBrowser(page);
  await browser.chooseRepo(CLIENT);
  await browser.openChanges();
  await expect(browser.diverged()).toBeVisible();
  await expect(browser.pull()).toHaveCount(0);
  await expect(browser.push()).toHaveCount(0);

  await browser.chooseRepo(API);
  await browser.openChanges();
  await expect(browser.diverged()).toHaveCount(0);
  await expect(browser.pull()).toHaveCount(0);
});
