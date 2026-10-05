/**
 * Settings > Context, the context browser (plan step 5.5). The hub is the production bundle with
 * a temp BAND_HOME. Files reach the hub's context repos the way an agent's worker puts them
 * there, with the real `git` binary over the hub's git endpoint, and the image is uploaded to
 * the hub's media store over `POST /media`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ContextBrowserPage } from "./pages/ContextBrowserPage";

test.use({ viewport: { width: 1280, height: 900 } });

const TOKEN = "e2e-context-browser-token";
// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let server: ServerHandle;
let tmpHome: string;
let remoteRepo: string;
const scratch: string[] = [];

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
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

/** Commits files into a context the way a worker does: clone, commit, push. */
function pushFiles(name: string, files: Record<string, string>, message: string): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "e2e-context-")));
  scratch.push(dir);
  const auth = ["-c", `http.extraHeader=Authorization: Bearer ${TOKEN}`];
  git(dir, ...auth, "clone", "-q", `${server.url}/git/context/${name}.git`, "wc");
  const wc = join(dir, "wc");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(wc, path)), { recursive: true });
    writeFileSync(join(wc, path), content);
  }
  git(wc, "add", "-A");
  git(wc, "commit", "-q", "-m", message);
  git(wc, ...auth, "push", "-q", "origin", "HEAD:main");
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, { repos: [] });
  server = await startServer({
    tmpHome,
    env: { BAND_CONTEXT_ALLOW_LOCAL_REMOTES: "1" },
  });
  await trpc("context.create", { name: "user" });
  await trpc("context.create", { name: "atlas" });

  const upload = await fetch(`${server.url}/media`, {
    method: "POST",
    headers: { "Content-Type": "image/png", Authorization: `Bearer ${TOKEN}` },
    body: PNG,
  });
  expect(upload.status).toBe(201);
  const { url: mediaLink } = (await upload.json()) as { url: string };
  expect(mediaLink).toMatch(/^band:\/\/media\//);

  pushFiles(
    "atlas",
    {
      "notes.md": `# Atlas notes\n\nThe architecture sketch:\n\n![sketch](${mediaLink})\n`,
      "learnings/2026-10-01-claude.md": "# Learned\n\nUse the staging cluster.\n",
      "handoffs/2026-10-02-codex.md": "# Handoff\n\nTests still fail on arm64.\n",
      "plan.md": "# Plan\n\nShip on Friday.\n",
      "plan.conflict-ab12.md": "# Plan\n\nShip on Monday.\n",
      "todo.md": "- keep this\n",
      "todo.conflict-cd34.md": "- drop this\n",
    },
    "Seed atlas",
  );

  remoteRepo = realpathSync(mkdtempSync(join(tmpdir(), "e2e-context-remote-")));
  scratch.push(remoteRepo);
  git(remoteRepo, "init", "-q", "--bare", "-b", "main", ".");
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  cleanupTmpHome(tmpHome);
});

test("browses the user and project contexts and renders a markdown file with its media image", async ({
  page,
}) => {
  const browser = new ContextBrowserPage(page, server.url, TOKEN);
  await browser.open();

  await browser.selectContext("user");
  await expect(browser.treeFile("preferences.md")).toBeVisible();

  await browser.selectContext("atlas");
  await browser.openFile("notes.md");
  await expect(browser.rendered()).toContainText("The architecture sketch");
  // The image loaded from the hub's media store, not just an <img> with a broken source.
  await expect(browser.images()).toHaveCount(1);
  await expect
    .poll(() => browser.images().evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  await expect(browser.recentEntries()).toHaveCount(2);
  await expect(browser.recentEntries().first()).toContainText("handoffs/2026-10-02-codex.md");
});

test("saves an edit as a commit that shows in the file history with its diff", async ({ page }) => {
  const browser = new ContextBrowserPage(page, server.url, TOKEN);
  await browser.open();
  await browser.selectContext("atlas");
  await browser.openFile("notes.md");

  await browser.edit("# Atlas notes\n\nRewritten by the user.\n", "Rewrite the notes");
  await expect(browser.rendered()).toContainText("Rewritten by the user.");

  await browser.openHistory();
  await expect(browser.commits().first()).toContainText("Rewrite the notes");
  await browser.commits().first().click();
  await expect(browser.diff()).toContainText("+Rewritten by the user.");
  await expect(browser.diff()).toContainText("-The architecture sketch:");

  // The commit is in the hub's git repo, where workers pull it from.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "e2e-context-check-")));
  scratch.push(dir);
  git(
    dir,
    "-c",
    `http.extraHeader=Authorization: Bearer ${TOKEN}`,
    "clone",
    "-q",
    `${server.url}/git/context/atlas.git`,
    "wc",
  );
  expect(git(join(dir, "wc"), "log", "--format=%s", "-1").trim()).toBe("Rewrite the notes");
  expect(readFileSync(join(dir, "wc", "notes.md"), "utf8")).toContain("Rewritten by the user.");
});

test("refuses to save text that holds a credential", async ({ page }) => {
  const browser = new ContextBrowserPage(page, server.url, TOKEN);
  await browser.open();
  await browser.selectContext("atlas");
  await browser.openFile("learnings/2026-10-01-claude.md");
  await browser.trySave("key: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n", "Add a key");
  await expect(browser.error()).toContainText("looks like it holds a credential");
});

test("highlights conflict files and resolves them, keeping the chosen version", async ({
  page,
}) => {
  const browser = new ContextBrowserPage(page, server.url, TOKEN);
  await browser.open();
  await browser.selectContext("atlas");
  await expect(browser.conflictCount()).toHaveText("2 conflicts");
  await expect(browser.treeFile("plan.conflict-ab12.md")).toHaveAttribute("data-conflict", "true");
  await expect(browser.treeFile("plan.md")).toHaveAttribute("data-conflict", "false");

  // Keep the conflict copy: its text lands on plan.md and the copy goes away.
  await browser.openFile("plan.conflict-ab12.md");
  await expect(browser.conflictBanner()).toBeVisible();
  await browser.keepConflictVersion();
  await expect(browser.treeFile("plan.conflict-ab12.md")).toHaveCount(0);
  await expect(browser.filePath()).toHaveText("plan.md");
  await expect(browser.rendered()).toContainText("Ship on Monday.");

  // Keep the original: the copy goes away and todo.md is unchanged.
  await browser.openFile("todo.conflict-cd34.md");
  await browser.keepOriginal();
  await expect(browser.treeFile("todo.conflict-cd34.md")).toHaveCount(0);
  await expect(browser.filePath()).toHaveText("todo.md");
  await expect(browser.conflictCount()).toHaveCount(0);
  await expect(
    browser.root.getByTestId("context-browser__raw").or(browser.rendered()),
  ).toContainText("keep this");
});

test("links a context to a remote repo and the hub pushes its branches there", async ({ page }) => {
  const browser = new ContextBrowserPage(page, server.url, TOKEN);
  await browser.open();
  await browser.selectContext("user");
  await browser.linkRemote(remoteRepo);
  await expect(browser.remoteUrl()).toHaveText(remoteRepo);
  expect(git(remoteRepo, "log", "--format=%s", "main").trim()).toContain("Scaffold context");
});
