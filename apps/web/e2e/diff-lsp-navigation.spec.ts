/**
 * LSP go-to-definition in the diff leaf, and the Cmd/Ctrl+hover link style
 * shared with the file editor.
 *
 *   - On the working-tree side of a diff, Cmd/Ctrl+hover marks a symbol that
 *     has a definition as a link, and Cmd/Ctrl+Click jumps to it: into an
 *     editor tab for another file, or by scrolling the diff for the same file.
 *   - The merge-base side of a split diff never links: its text is an older
 *     revision the language server does not have.
 *   - The link colours the whole symbol (every highlighted span inside it)
 *     in the theme's `--link` colour, in light and dark themes, in both the
 *     diff and the editor.
 *
 * The language server is real: the fixture repo is a small TypeScript
 * project whose `node_modules` links to the `typescript-language-server` and
 * `typescript` packages this app installs, which is where the server's LSP
 * manager looks for them (`<worktree>/node_modules/.bin`). Nothing in Band is
 * mocked; the server spawns the language server as it does for a user.
 */

import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { createTsLspRepo } from "../tests/fixtures/ts-lsp-repo";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChangesPanelPage } from "./pages/ChangesPanelPage";

// Wide enough for the desktop layout and a side-by-side split.
test.use({ viewport: { width: 1800, height: 800 } });

const TOKEN = "e2e-diff-lsp-navigation-token";
const REPO_NAME = "lsp-diff-repo";
const BRANCH = "main";
// The `--link` token in `styles/globals.css`, as the browser computes it.
const LINK_COLOUR = {
  light: "oklch(0.546 0.245 262.881)",
  dark: "oklch(0.707 0.165 254.624)",
};

// Long runs of filler lines put each definition far below the line that
// uses it, so "the definition scrolled into view" is observable.
const filler = (label: string) =>
  Array.from({ length: 120 }, (_, i) => `// ${label} filler ${i + 1}`);

const MATH_TS = [
  ...filler("math"),
  "export function addNumbers(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

const MAIN_BEFORE = [
  'import { addNumbers } from "./math";',
  "",
  "export const total = addNumbers(1, 2);",
  "",
].join("\n");

const MAIN_AFTER = [
  'import { addNumbers } from "./math";',
  "",
  "export const total = addNumbers(1, 2);",
  "export const doubled = addNumbers(total, localHelper());",
  ...filler("main"),
  "function localHelper(): number {",
  "  return 4;",
  "}",
  "",
].join("\n");

const TOTAL_LINE = "export const total = addNumbers(1, 2);";
const DOUBLED_LINE = "export const doubled = addNumbers(total, localHelper());";
const ADD_NUMBERS_DEF = "export function addNumbers(a: number, b: number): number {";
const LOCAL_HELPER_DEF = "function localHelper(): number {";

function bootServer(theme: "light" | "dark") {
  const ctx: { server: ServerHandle; tmpHome: string; workspaceId: string } = {
    server: undefined as unknown as ServerHandle,
    tmpHome: "",
    workspaceId: toWorkspaceId(REPO_NAME, BRANCH),
  };
  test.beforeAll(async () => {
    ctx.tmpHome = createTmpHome();
    const repoPath = join(ctx.tmpHome, REPO_NAME);
    createTsLspRepo({
      repoPath,
      branch: BRANCH,
      committed: { "src/math.ts": MATH_TS, "src/main.ts": MAIN_BEFORE },
      working: { "src/main.ts": MAIN_AFTER },
    });
    seedState(ctx.tmpHome, {
      projects: [
        {
          name: REPO_NAME,
          path: repoPath,
          defaultBranch: BRANCH,
          worktrees: [{ branch: BRANCH, path: repoPath }],
        },
      ],
    });
    seedSettings(ctx.tmpHome, { tokenSecret: TOKEN, enableLSP: true, theme });
    ctx.server = await startServer({ tmpHome: ctx.tmpHome });
  });
  test.afterAll(async () => {
    if (ctx.server) await ctx.server.close();
    if (ctx.tmpHome) cleanupTmpHome(ctx.tmpHome);
  });
  return ctx;
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`diff go-to-definition (${theme} theme)`, () => {
    const ctx = bootServer(theme);

    test("Cmd+hover links a symbol in the link colour, Cmd+Click opens its definition in another file", async ({
      page,
    }) => {
      const changes = new ChangesPanelPage(page, ctx.server.url, TOKEN);
      await changes.goto(ctx.workspaceId);
      await changes.openDiff("src/main.ts", "unified");
      const diff = changes.symbols("new");

      await diff.cmdHover(DOUBLED_LINE, "addNumbers");
      await diff.expectLinkOn("addNumbers");
      // The whole symbol, including any highlighted span inside the link.
      expect(await diff.linkColours()).toEqual([LINK_COLOUR[theme]]);
      await diff.releaseModifier();
      await expect(diff.link).toHaveCount(0);

      await diff.cmdClick(DOUBLED_LINE, "addNumbers");
      const editor = changes.openedEditor;
      await editor.expectContent(ADD_NUMBERS_DEF);
      await expect(editor.symbols.line(ADD_NUMBERS_DEF)).toBeInViewport();

      // The editor draws the same link.
      await editor.symbols.cmdHover(ADD_NUMBERS_DEF, "addNumbers");
      await editor.symbols.expectLinkOn("addNumbers");
      expect(await editor.symbols.linkColours()).toEqual([LINK_COLOUR[theme]]);
      await editor.symbols.releaseModifier();
    });
  });
}

test.describe("diff go-to-definition", () => {
  const ctx = bootServer("light");

  test("Cmd+Click on a symbol defined in the same file scrolls the diff to it", async ({
    page,
  }) => {
    const changes = new ChangesPanelPage(page, ctx.server.url, TOKEN);
    await changes.goto(ctx.workspaceId);
    await changes.openDiff("src/main.ts", "unified");
    const diff = changes.symbols("new");
    await expect(diff.line(DOUBLED_LINE)).toBeInViewport();

    await diff.cmdHover(DOUBLED_LINE, "localHelper");
    await diff.expectLinkOn("localHelper");
    await diff.releaseModifier();
    await diff.cmdClick(DOUBLED_LINE, "localHelper");

    await expect(diff.line(LOCAL_HELPER_DEF)).toBeInViewport();
    await expect(diff.line(DOUBLED_LINE)).not.toBeInViewport();
    await expect(changes.fileLeaves).toHaveCount(0);
  });

  test("A word with no definition is not linked", async ({ page }) => {
    const changes = new ChangesPanelPage(page, ctx.server.url, TOKEN);
    await changes.goto(ctx.workspaceId);
    await changes.openDiff("src/main.ts", "unified");
    const diff = changes.symbols("new");

    // Positive anchor: a symbol on a nearby line links within a round trip.
    await diff.cmdHover(DOUBLED_LINE, "addNumbers");
    await diff.expectLinkOn("addNumbers");
    await diff.releaseModifier();

    // A word inside a comment has nothing to jump to.
    await diff.cmdHover("// main filler 1", "filler");
    await diff.expectNoLinkFor();
    await diff.releaseModifier();
  });

  test("Split view links only the working-tree side, not the merge-base side", async ({ page }) => {
    const changes = new ChangesPanelPage(page, ctx.server.url, TOKEN);
    await changes.goto(ctx.workspaceId);
    await changes.openDiff("src/main.ts", "split");

    // The unchanged line is on both sides. The working-tree side links it...
    const newSide = changes.symbols("new");
    await newSide.cmdHover(TOTAL_LINE, "addNumbers");
    await newSide.expectLinkOn("addNumbers");
    await newSide.releaseModifier();

    // ...the merge-base side does not.
    const oldSide = changes.symbols("old");
    await oldSide.cmdHover(TOTAL_LINE, "addNumbers");
    await oldSide.expectNoLinkFor();
    await oldSide.releaseModifier();

    // Cmd+Click there opens nothing. A same-file jump on the working-tree side
    // afterwards completes a full server round trip, after which a navigation
    // from the old side would already have opened an editor.
    await oldSide.cmdClick(TOTAL_LINE, "addNumbers");
    await newSide.cmdClick(DOUBLED_LINE, "localHelper");
    await expect(newSide.line(LOCAL_HELPER_DEF)).toBeInViewport();
    await expect(changes.fileLeaves).toHaveCount(0);
  });

  test("The diff keeps linking after an editor opens and closes the same file", async ({
    page,
  }) => {
    const changes = new ChangesPanelPage(page, ctx.server.url, TOKEN);
    await changes.goto(ctx.workspaceId);
    await changes.openDiff("src/main.ts", "unified");

    // An editor on the same file takes the document over on the server...
    await changes.openDiffFileInEditor();
    await changes.openedEditor.expectContent(DOUBLED_LINE);
    // ...and closing it hands the diff's text back.
    await changes.closeEditor("src/main.ts");
    await changes.showDiff("src/main.ts");

    const diff = changes.symbols("new");
    await diff.cmdHover(DOUBLED_LINE, "localHelper");
    await diff.expectLinkOn("localHelper");
    await diff.releaseModifier();
    await diff.cmdClick(DOUBLED_LINE, "localHelper");
    await expect(diff.line(LOCAL_HELPER_DEF)).toBeInViewport();
  });

  test("The diff stops linking a line an editor's unsaved edits have moved", async ({ page }) => {
    const changes = new ChangesPanelPage(page, ctx.server.url, TOKEN);
    await changes.goto(ctx.workspaceId);
    await changes.openDiff("src/main.ts", "unified");
    const diff = changes.symbols("new");

    // Positive anchor: the line links while the editor matches the disk.
    await changes.openDiffFileInEditor();
    await changes.openedEditor.expectContent(DOUBLED_LINE);
    await changes.showDiff("src/main.ts");
    await diff.cmdHover(DOUBLED_LINE, "addNumbers");
    await diff.expectLinkOn("addNumbers");
    await diff.releaseModifier();

    // An unsaved line at the top shifts every line in the editor's copy, so
    // the diff's line 4 is no longer the server's line 4.
    await changes.showEditor("src/main.ts");
    await changes.openedEditor.typeAtStart("// unsaved\n");
    await changes.showDiff("src/main.ts");
    await diff.cmdHover(DOUBLED_LINE, "addNumbers");
    await diff.expectNoLinkFor();
    await diff.releaseModifier();
  });
});
