/**
 * End-to-end coverage for the markdown-preview find bar (issue #435).
 *
 * Drives a real Band server against an on-disk worktree containing a
 * markdown file with deterministic match counts, then exercises the
 * find UX through the renderer: open with Cmd+F, count matches, step
 * through them with Enter / Shift+Enter, and dismiss with Escape.
 *
 * The test runs against Playwright's bundled Chromium, which supports
 * the CSS Custom Highlight API the preview uses for painting. The
 * assertions key off observable UI state (the match counter, the
 * input's presence and focus) rather than the highlight overlay
 * itself, so the test stays useful even on browsers that fall back to
 * the no-paint path.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";

// Force the mobile layout (viewport < 1024 px) so the workspace route's
// `Outlet` mounts `CodeBrowserView` directly via the routed component
// tree rather than going through the dockview panel manager. The find
// bar's behaviour is identical in either layout — but the mobile path
// keeps the test focused on the preview and skips deep dockview /
// chat-pane setup that would otherwise need to be coaxed.
test.use({ viewport: { width: 800, height: 900 } });

const TOKEN = "e2e-find-md-token";
const REPO_NAME = "find-md-repo";
const BRANCH = "main";
const FILE_PATH = "GUIDE.md";

// Three occurrences of "needle" across H1, body, and a deeper section
// so we can verify wrap-around navigation as well as match counting.
const MARKDOWN_CONTENT = [
  "# Test Document",
  "",
  "This is a paragraph mentioning the needle in passing.",
  "",
  "## Section A",
  "",
  "Lorem ipsum dolor sit amet. The needle is here again.",
  "",
  "Some unrelated prose without the search term.",
  "",
  "## Section B",
  "",
  "Final occurrence of needle at the end.",
  "",
].join("\n");

let server: ServerHandle;
let tmpHome: string;
let workspaceId: string;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv });
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });

  // A bare metadata seed isn't enough — `workspace.getFile` reads the
  // file off disk, so we need a real worktree with the markdown file
  // committed. One commit is enough; the find bar doesn't care about
  // branch state.
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, FILE_PATH), MARKDOWN_CONTENT);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);

  seedState(tmpHome, {
    projects: [
      {
        name: REPO_NAME,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  workspaceId = toWorkspaceId(REPO_NAME, BRANCH);
});

test.afterAll(async () => {
  await server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Navigate to the workspace, switch to the Files tab, then click the
 * markdown file in the tree. Post-#467 (route unification), the workspace
 * URL no longer carries a sub-path for the active tab OR the selected file
 * — both live in `MobileWorkspaceLayout`'s local state — so this drives
 * the same UI flow a real mobile user would take.
 */
async function openMarkdownPreview(page: Page): Promise<void> {
  await page.goto(`${server.url}/workspace/${encodeURIComponent(workspaceId)}?token=${TOKEN}`);

  // Switch to the Files tab. The button's aria-label is set in
  // `WorkspaceTabNav.tsx` — system-controlled, so `getByRole({ name })` is
  // safe per `docs/frontend-testing.md` §7.
  await page.getByRole("button", { name: "Files" }).click();

  // Click the markdown file in the tree. File-tree rows are buttons whose
  // accessible name is the bare filename — `getByRole({ name })` keeps the
  // locator unambiguous (the filename also appears in the tab bar after the
  // click, which would trip Playwright's strict mode if we used
  // `getByText`). `exact: true` defends against any future button whose
  // label contains the filename as a substring (e.g. an "Open GUIDE.md"
  // menu item). Aligns with the locator-priority rules in
  // `docs/frontend-testing.md` §7 and CLAUDE.md.
  await page.getByRole("button", { name: FILE_PATH, exact: true }).click();

  // The markdown renders into a sticky heading — when it appears, the
  // preview is laid out and ready for the find bar to attach its keybind.
  await expect(page.getByRole("heading", { level: 1, name: "Test Document" })).toBeVisible({
    timeout: 20_000,
  });
}

test("Cmd+F opens the find bar, counts and steps through matches, Esc closes", async ({ page }) => {
  await openMarkdownPreview(page);

  // The find bar uses a single placeholder string in both source and
  // preview modes — only the search target differs internally. The
  // placeholder flips to "Find in preview..." while the preview is the
  // active surface.
  const findInput = page.getByPlaceholder(/Find in (preview|file)\.\.\./);
  await expect(findInput).toHaveCount(0);

  // Cmd+F goes through `DockviewWorkspaceLayout`'s capture-phase
  // keybind → `useSearch.handleOpenSearch` → renders the toolbar
  // SearchBar. CodeBrowserView routes the input through to
  // MarkdownPreview's imperative ref while preview mode is active.
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+f`);

  // Exactly one find bar should appear — the unified top one. The old
  // "stacked bars" regression (#435 follow-up) would surface here as a
  // second input with the same placeholder.
  await expect(findInput).toHaveCount(1);
  await expect(findInput).toBeVisible();
  await expect(findInput).toBeFocused();
  await expect(findInput).toHaveAttribute("placeholder", "Find in preview...");

  await findInput.fill("needle");

  // "needle" appears 3× in the fixture — once in the first paragraph,
  // once under Section A, and once under Section B. The counter starts
  // on the first match.
  await expect(page.getByText("1 of 3")).toBeVisible();

  // Enter advances to the next match.
  await findInput.press("Enter");
  await expect(page.getByText("2 of 3")).toBeVisible();

  await findInput.press("Enter");
  await expect(page.getByText("3 of 3")).toBeVisible();

  // Wrap-around: another Enter cycles back to the first match.
  await findInput.press("Enter");
  await expect(page.getByText("1 of 3")).toBeVisible();

  // Shift+Enter walks backwards.
  await findInput.press("Shift+Enter");
  await expect(page.getByText("3 of 3")).toBeVisible();

  // No-result query updates the counter to "No results" (the SearchBar
  // renders this string when matchInfo.total === 0 and there is a
  // query).
  await findInput.fill("xyzzzzzzzzzzzz");
  await expect(page.getByText("No results")).toBeVisible();

  // Escape closes the bar.
  await findInput.press("Escape");
  await expect(findInput).toHaveCount(0);
});
