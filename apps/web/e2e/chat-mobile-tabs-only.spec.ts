/**
 * On a mobile viewport the chat panel must render every chat as a TAB, never a
 * split. `MobileWorkspaceLayout` (`workspace.$workspaceId.tsx`) mounts
 * `DockviewChatContainer` with `allowSplit={false}` — the same inner container
 * the desktop layout uses — replacing the old single-pane `MobileChatContent`
 * that only ever showed the first chat. `allowSplit={false}`:
 *   - hides the "Split right" / "Split down" buttons (only "New chat tab"
 *     remains), and
 *   - flattens any saved (desktop-created) split layout into one tabbed group
 *     by rebuilding from the live `chats.list`.
 *
 * Architecture mirrors the other mobile specs: the REAL production
 * `dist/start-server.mjs` boots against a fresh tmp `$HOME` with on-disk git
 * worktrees; no tRPC mocking. Chats are created through the real `chats.create`
 * mutation and the assertions read the rendered DOM (`dockview-chat__toolbar`,
 * the `chat-tab__trigger--*` headers).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

// Narrow viewport — `useIsDesktop()` reports false (threshold 1024px), so the
// workspace renders the mobile tab layout rather than the shared dockview.
test.use({ viewport: { width: 800, height: 900 } });

const TOKEN = "e2e-chat-mobile-tabs-only-token";
const BRANCH = "main";
// One repo per test so chats from one never leak into the other (the server +
// tmp home are shared across the file).
const REPO_A = "chat-mobile-repo-a";
const REPO_B = "chat-mobile-repo-b";

let server: ServerHandle;
let tmpHome: string;

function initRepo(name: string): string {
  const repoPath = join(tmpHome, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoAPath = initRepo(REPO_A);
  const repoBPath = initRepo(REPO_B);
  seedState(tmpHome, {
    projects: [
      {
        name: REPO_A,
        path: repoAPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoAPath }],
      },
      {
        name: REPO_B,
        path: repoBPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoBPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  // No retry loop (unlike terminal-mobile-tabs-only.spec.ts): chats never spawn
  // PTYs, so there are no shell grandchildren lingering in the server's process
  // group past `server.close()` to keep the tmp home busy. `cleanupTmpHome`'s
  // internal retries cover the only remaining writers (short-lived background
  // tasks), so the ENOTEMPTY window that motivated the terminal spec's loop
  // doesn't apply here.
  cleanupTmpHome(tmpHome);
});

test.describe("mobile chat is tabs-only (never split)", () => {
  test("the chat toolbar offers add-tab but no split controls", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const workspaceId = toWorkspaceId(REPO_A, BRANCH);

    // Chat is the default active tab, so it mounts on load.
    await workspacePage.goto(workspaceId);
    await workspacePage.waitForMobileReady();
    await workspacePage.waitForMobileChatReady();

    await expect(workspacePage.mobileChatNewButton).toBeVisible();
    await expect(workspacePage.splitRightButtons).toHaveCount(0);
  });

  test("multiple chats render as tabs in a single group", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const workspaceId = toWorkspaceId(REPO_B, BRANCH);

    await workspacePage.createChat(workspaceId, "chat_11111111-1111-4111-8111-111111111111");
    await workspacePage.createChat(workspaceId, "chat_22222222-2222-4222-8222-222222222222");

    await workspacePage.goto(workspaceId);
    await workspacePage.waitForMobileReady();
    await workspacePage.waitForMobileChatReady();

    // Both chats appear as tabs in ONE group: exactly one grid toolbar (a split
    // would render one per group) and no split buttons.
    await expect(workspacePage.chatTabHeaders).toHaveCount(2);
    await expect(workspacePage.mobileChatToolbar).toHaveCount(1);
    await expect(workspacePage.splitRightButtons).toHaveCount(0);
  });
});
