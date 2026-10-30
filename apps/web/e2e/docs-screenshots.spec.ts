/**
 * Screenshots for the public docs (`apps/website`). It boots the real production hub against a
 * temp `~/.band/` seeded with a repo called `my-app`, three titled worktrees in two groups, a
 * real second worker and a scripted chat, and saves PNGs of the real UI into
 * `apps/website/public/docs/screenshots/`.
 *
 * It writes files rather than asserting behaviour, so it only runs with `BAND_DOCS_SCREENSHOTS=1`
 * (`pnpm --filter @band-app/web test:e2e:docs-screenshots`).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
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
import { trpcMutate, trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { DocsScreenshotsPage } from "./pages/DocsScreenshotsPage";

const ENABLED = process.env.BAND_DOCS_SCREENSHOTS === "1";
const TOKEN = "e2e-docs-screenshots-token";
const REPO = "my-app";
const FEATURES = "g-features";
const FIXES = "g-fixes";
const WT_MAIN = toWorktreeId(REPO, "main", "local");
const WT_LOGIN = toWorktreeId(REPO, "add-oauth-login", "local");
const WT_FIX = toWorktreeId(REPO, "fix-token-refresh", "local");

test.skip(
  !ENABLED,
  "Writes docs images only when BAND_DOCS_SCREENSHOTS=1 (see test:e2e:docs-screenshots)",
);
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle | undefined;
let workerId = "";
const scratch: string[] = [];

const tmpDir = (prefix: string) => {
  // /tmp keeps the paths the Add repo picker shows short.
  const dir = realpathSync(mkdtempSync(join("/tmp", prefix)));
  scratch.push(dir);
  return dir;
};

function write(dir: string, file: string, content: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const main = join(tmpHome, REPO);
  mkdirSync(main, { recursive: true });
  git(main, ["init", "-b", "main"]);
  write(main, "package.json", '{\n  "name": "my-app",\n  "version": "1.0.0"\n}\n');
  write(main, "src/auth.ts", "export function signIn(user: string) {\n  return { user };\n}\n");
  write(main, "src/session.ts", "export const SESSION_TTL = 3600;\n");
  write(main, "README.md", "# my-app\n");
  gitCommit(main, "initial commit");

  const extra = (branch: string) => {
    const path = join(tmpHome, `${REPO}-${branch}`);
    git(main, ["worktree", "add", "-b", branch, path]);
    return path;
  };
  const login = extra("add-oauth-login");
  const fix = extra("fix-token-refresh");

  // Uncommitted work in the login worktree, for the Changes tab.
  write(
    login,
    "src/auth.ts",
    [
      'import { oauthRedirect } from "./oauth";',
      "",
      "export function signIn(user: string) {",
      "  return { user, provider: null };",
      "}",
      "",
      "export function signInWithGitHub() {",
      '  return oauthRedirect("github");',
      "}",
      "",
    ].join("\n"),
  );
  write(
    login,
    "src/oauth.ts",
    [
      "export function oauthRedirect(provider: string) {",
      "  return `/auth/$" + "{provider}`;",
      "}",
      "",
    ].join("\n"),
  );
  write(login, "src/login-form.tsx", "export function LoginForm() {\n  return null;\n}\n");
  write(login, "README.md", "# my-app\n\nSign in with GitHub.\n");
  write(fix, "src/session.ts", "export const SESSION_TTL = 7200;\n");

  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  seedState(tmpHome, {
    groups: [
      { id: FEATURES, name: "Features", color: "#8b5cf6" },
      { id: FIXES, name: "Bug fixes", color: "#f59e0b" },
    ],
    repos: [
      {
        name: REPO,
        path: main,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: main },
          { branch: "add-oauth-login", path: login, groupId: FEATURES },
          { branch: "fix-token-refresh", path: fix, groupId: FIXES },
        ],
      },
    ],
  });

  server = await startServer({
    tmpHome,
    env: {
      BAND_UPDATE_CHECK: "off",
      ...acpStubEnv(tmpHome, {
        turns: [
          {
            steps: [
              {
                say: "I added `signInWithGitHub` and a redirect helper in `src/oauth.ts`. The login form is next. Do you want the session stored in a cookie or in local storage?",
                chunks: 4,
              },
            ],
          },
        ],
      }),
    },
  });

  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: "build-box", labels: [] },
  );
  workerId = issued.hostId;
  // The worker's home is also its root, with the folders the Add repo picker lists.
  const workerHome = tmpDir("work-");
  for (const folder of ["my-api", "my-app", "docs-site", "dotfiles"]) {
    mkdirSync(join(workerHome, "projects", folder), { recursive: true });
  }
  worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: issued.hostId,
    },
    root: workerHome,
    stateDir: tmpDir("band-docs-worker-state-"),
    home: workerHome,
  });
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{ hosts: { id: string; status: string }[] }>(
          server.url,
          TOKEN,
          "hosts.list",
        );
        return hosts.find((h) => h.id === workerId)?.status;
      },
      { timeout: 30_000 },
    )
    .toBe("online");

  const titles: [string, string][] = [
    [WT_MAIN, "Main"],
    [WT_LOGIN, "GitHub sign-in"],
    [WT_FIX, "Fix token refresh"],
  ];
  for (const [worktreeId, title] of titles) {
    await trpcMutate(server.url, TOKEN, "worktrees.setTitle", { worktreeId, title });
  }
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server?.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

test("dashboard.png and changes.png: sidebar, a chat and the Changes tab", async ({ page }) => {
  const docs = new DocsScreenshotsPage(page, server.url, TOKEN);
  await docs.openWorktreeWithChat(WT_LOGIN);
  await docs.waitForSidebar([WT_MAIN, WT_LOGIN, WT_FIX]);
  await docs.dismissHooksBanner();
  await docs.converse(
    "Add a GitHub sign-in button to the login page",
    "session stored in a cookie",
  );
  await docs.worktree.setAgentStatus(WT_FIX, "done");
  await docs.shootChanges("changes.png");
  await docs.shootPage("dashboard.png");
});

test("settings.png: a general section", async ({ page }) => {
  const docs = new DocsScreenshotsPage(page, server.url, TOKEN);
  await docs.shootGeneralSettings("settings.png");
});

test("settings-devices.png: one device", async ({ page }) => {
  const docs = new DocsScreenshotsPage(page, server.url, TOKEN);
  await docs.shootDevices("settings-devices.png", "Aleksandar's iPhone");
});

test("settings-workers.png: the local worker and a second one", async ({ page }) => {
  const docs = new DocsScreenshotsPage(page, server.url, TOKEN);
  await docs.shootWorkers("settings-workers.png", ["build-box"]);
});

test.describe("dialogs at 2x", () => {
  test.use({ deviceScaleFactor: 2 });

  test("add-repo.png: From a worker", async ({ page }) => {
    const docs = new DocsScreenshotsPage(page, server.url, TOKEN);
    await docs.worktree.goto(WT_MAIN);
    await docs.worktree.waitForReady();
    await docs.shootAddRepo("add-repo.png", workerId, "projects");
  });

  test("new-worktree.png: Worker field", async ({ page }) => {
    const docs = new DocsScreenshotsPage(page, server.url, TOKEN);
    await docs.worktree.goto(WT_MAIN);
    await docs.worktree.waitForReady();
    await docs.shootNewWorktree("new-worktree.png", FEATURES, REPO, "add-dark-mode");
  });
});
