/**
 * The right-click menu on a text selection (`SelectionContextMenu.tsx`), which
 * replaced the floating selection tooltip, in the file editor, both sides of a
 * split diff, a unified diff, and a terminal.
 *
 *   - Selecting text shows nothing on its own; a right-click opens the menu
 *     and keeps the selection.
 *   - Code menus offer Add to Chat, Add to Terminal and Copy reference for the
 *     selection, then Cut / Copy / Paste / Select All as the surface allows.
 *     With nothing selected only the general items show.
 *   - The terminal menu offers Add to Chat (the selected text as a fenced
 *     block), Copy, Paste and Select All.
 *
 * The REAL `dist/start-server.mjs` runs against a tmp `$HOME` with an on-disk
 * git repo per test, so chat drafts and tab layouts can't leak between tests.
 * Clipboard writes are captured by `WorkspacePage.installClipboardCapture`
 * (the `execCommand("copy")` fallback), and terminal input by
 * `installTerminalSendCapture` (the string frames sent on `/terminal?`).
 *
 * `src/notes.txt` is committed as `alpha, beta` and left on disk as
 * `alpha, gamma, beta`, so `beta` is line 2 on the old side of the diff and
 * line 3 on the new side: the reference must use the side that was clicked.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChangesPanelPage } from "./pages/ChangesPanelPage";
import { ChatPanePage } from "./pages/ChatPanePage";
import { SelectionMenu } from "./pages/SelectionMenu";
import { TerminalInputSurface } from "./pages/TerminalInputSurface";
import { WorkspacePage } from "./pages/WorkspacePage";

// Wide viewport so `useIsDesktop()` reports true and the diff leaf can split.
test.use({ viewport: { width: 2400, height: 900 } });

const TOKEN = "e2e-selection-context-menu-token";
const BRANCH = "main";
const FILE_PATH = "src/notes.txt";
const REPOS = ["sel-menu-editor", "sel-menu-split", "sel-menu-unified", "sel-menu-terminal"];
const COPY_SHORTCUT = process.platform === "darwin" ? "⌘C" : "Ctrl+C";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  for (const name of REPOS) {
    const repoPath = join(tmpHome, name);
    mkdirSync(join(repoPath, "src"), { recursive: true });
    git(repoPath, ["init", "-b", BRANCH]);
    writeFileSync(join(repoPath, FILE_PATH), "alpha\nbeta\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial"]);
    writeFileSync(join(repoPath, FILE_PATH), "alpha\ngamma\nbeta\n");
  }
  seedState(tmpHome, {
    projects: REPOS.map((name) => {
      const path = join(tmpHome, name);
      return { name, path, defaultBranch: BRANCH, worktrees: [{ branch: BRANCH, path }] };
    }),
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    // The DOM renderer, so `runInTerminalUntilRendered` can read the rows.
    useWebGLTerminalRenderer: false,
    // The chat Add to Chat delivers into runs the scripted ACP stub agent.
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("file editor: a selection shows no popup, and right-click offers the file actions", async ({
  page,
}) => {
  const workspaceId = toWorkspaceId("sel-menu-editor", BRANCH);
  const workspace = new WorkspacePage(page, server.url, TOKEN);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  const menu = new SelectionMenu(page);
  await workspace.installClipboardCapture();

  // The default layout has no chat; open one for Add to Chat to deliver into.
  await chat.goto(workspaceId);
  await chat.waitForReady();
  await workspace.openFileLeaf(FILE_PATH, workspaceId);
  const editor = workspace.fileLeafVisibilityMarker(true).first();

  await menu.selectWordInEditor(editor, "gamma");
  // Anchor: the word is selected (Copy puts exactly it on the clipboard below),
  // and nothing opened on the selection alone.
  await expect(menu.root).toHaveCount(0);

  await menu.openOnEditorWord(editor, "gamma");
  await expect(menu.root).toBeVisible();
  for (const item of [
    "add-to-chat",
    "add-to-terminal",
    "copy-reference",
    "cut",
    "copy",
    "paste",
    "select-all",
  ] as const) {
    await expect(menu.item(item)).toBeVisible();
  }
  await expect(menu.shortcut("copy")).toHaveText(COPY_SHORTCUT);

  // The right-click kept the selection: Copy copies the word.
  await menu.choose("copy");
  await expect.poll(async () => (await workspace.readCopied()).at(-1)).toBe("gamma");

  await menu.openOnEditorWord(editor, "gamma");
  await menu.choose("copy-reference");
  await expect.poll(async () => (await workspace.readCopied()).at(-1)).toBe(`${FILE_PATH}:2`);

  await menu.openOnEditorWord(editor, "gamma");
  await menu.choose("add-to-chat");
  await expect.poll(async () => await chat.promptValue()).toBe(`\`${FILE_PATH}:2\` `);

  // Nothing selected: only the general items. Add to Chat showed the chat, so
  // bring the file back first.
  await workspace.focusFileEditor(FILE_PATH);
  await menu.openOnEditorBlank(editor, "alpha");
  await expect(menu.item("select-all")).toBeVisible();
  await expect(menu.item("paste")).toBeVisible();
  await expect(menu.item("add-to-chat")).toHaveCount(0);
  await expect(menu.item("copy-reference")).toHaveCount(0);
  await expect(menu.item("copy")).toHaveCount(0);
});

test("split diff: each side's reference uses that side's line numbers", async ({ page }) => {
  const workspaceId = toWorkspaceId("sel-menu-split", BRANCH);
  const workspace = new WorkspacePage(page, server.url, TOKEN);
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  const menu = new SelectionMenu(page);
  await workspace.installClipboardCapture();
  await workspace.installTerminalSendCapture();

  // Boot the terminal first so Add to Terminal has a live PTY to type into.
  await workspace.goto(workspaceId);
  await workspace.waitForReady();
  await workspace.openTerminalTab();
  await workspace.waitForTerminalReady();

  await changes.goto(workspaceId);
  await changes.openDiff(FILE_PATH, "split");

  const oldSide = changes.diffEditor("old");
  await menu.selectWordInEditor(oldSide, "beta");
  await expect(menu.root).toHaveCount(0);
  await menu.openOnEditorWord(oldSide, "beta");
  // Read-only: Copy but no Cut or Paste.
  await expect(menu.item("copy")).toBeVisible();
  await expect(menu.item("cut")).toHaveCount(0);
  await expect(menu.item("paste")).toHaveCount(0);
  await menu.choose("copy-reference");
  await expect.poll(async () => (await workspace.readCopied()).at(-1)).toBe(`${FILE_PATH}:2`);

  const newSide = changes.diffEditor("new");
  await menu.selectWordInEditor(newSide, "beta");
  await menu.openOnEditorWord(newSide, "beta");
  await menu.choose("add-to-terminal");
  await expect.poll(async () => await workspace.readTerminalSent()).toContain(`${FILE_PATH}:3 `);
});

test("unified diff: Add to Chat appends the reference to the chat input", async ({ page }) => {
  const workspaceId = toWorkspaceId("sel-menu-unified", BRANCH);
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  const menu = new SelectionMenu(page);

  await chat.goto(workspaceId);
  await chat.waitForReady();
  await changes.goto(workspaceId);
  await changes.openDiff(FILE_PATH, "unified");
  const editor = changes.diffEditor("new");

  await menu.selectWordInEditor(editor, "gamma");
  await expect(menu.root).toHaveCount(0);
  await menu.openOnEditorWord(editor, "gamma");
  await expect(menu.item("add-to-terminal")).toBeVisible();
  await expect(menu.item("copy-reference")).toBeVisible();
  await menu.choose("add-to-chat");
  await expect.poll(async () => await chat.promptValue()).toBe(`\`${FILE_PATH}:2\` `);
});

test("terminal: right-click offers Add to Chat, Copy, Paste and Select All", async ({ page }) => {
  const workspaceId = toWorkspaceId("sel-menu-terminal", BRANCH);
  const workspace = new WorkspacePage(page, server.url, TOKEN);
  const terminal = new TerminalInputSurface(page, workspaceId);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  const menu = new SelectionMenu(page);
  await workspace.installClipboardCapture();

  await chat.goto(workspaceId);
  await chat.waitForReady();
  await workspace.openTerminalTab();
  await workspace.waitForTerminalReady();
  // The shell prints `selmark42`; the command line itself shows the
  // unexpanded `$((40+2))`, so only the output row has the word.
  await workspace.runInTerminalUntilRendered(workspaceId, "echo selmark$((40+2))", /selmark42/);

  await terminal.selectWord("selmark42");
  await expect.poll(() => terminal.readSelection()).toBe("selmark42");
  await expect(menu.root).toHaveCount(0);

  await terminal.rightClickWord("selmark42");
  await expect(menu.item("add-to-chat")).toBeVisible();
  await expect(menu.item("copy")).toBeVisible();
  await expect(menu.item("paste")).toBeVisible();
  await expect(menu.item("select-all")).toBeVisible();
  // No file behind terminal text, so no reference actions.
  await expect(menu.item("copy-reference")).toHaveCount(0);
  await expect(menu.item("add-to-terminal")).toHaveCount(0);
  await menu.choose("copy");
  await expect.poll(async () => (await workspace.readCopied()).at(-1)).toBe("selmark42");

  await terminal.rightClickWord("selmark42");
  await menu.choose("add-to-chat");
  await expect.poll(async () => await chat.promptValue()).toBe("```\nselmark42\n```\n");
});
