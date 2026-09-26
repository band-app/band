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

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { ChangesPanelPage } from "./pages/ChangesPanelPage";
import { FileViewerPage } from "./pages/FileViewerPage";

// Wide enough for the desktop layout and a side-by-side split.
test.use({ viewport: { width: 1800, height: 800 } });

const TOKEN = "e2e-diff-lsp-navigation-token";
const REPO_NAME = "lsp-diff-repo";
const BRANCH = "main";
const APP_NODE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));

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

/** A TypeScript repo with `src/main.ts` modified in the working tree. */
function createRepo(tmpHome: string): string {
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "src"), { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, ".gitignore"), "node_modules\n");
  writeFileSync(
    join(repoPath, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, module: "esnext" }, include: ["src"] }),
  );
  writeFileSync(join(repoPath, "src/math.ts"), MATH_TS);
  writeFileSync(join(repoPath, "src/main.ts"), MAIN_BEFORE);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  writeFileSync(join(repoPath, "src/main.ts"), MAIN_AFTER);

  mkdirSync(join(repoPath, "node_modules/.bin"), { recursive: true });
  symlinkSync(
    realpathSync(join(APP_NODE_MODULES, "typescript")),
    join(repoPath, "node_modules/typescript"),
  );
  symlinkSync(
    join(APP_NODE_MODULES, ".bin/typescript-language-server"),
    join(repoPath, "node_modules/.bin/typescript-language-server"),
  );
  return repoPath;
}

function bootServer(theme: "light" | "dark") {
  const ctx: { server: ServerHandle; tmpHome: string; workspaceId: string } = {
    server: undefined as unknown as ServerHandle,
    tmpHome: "",
    workspaceId: toWorkspaceId(REPO_NAME, BRANCH),
  };
  test.beforeAll(async () => {
    ctx.tmpHome = createTmpHome();
    const repoPath = createRepo(ctx.tmpHome);
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
      const diffColours = await diff.linkColours();
      for (const colour of diffColours.actual) expect(colour).toBe(diffColours.expected);
      await diff.releaseModifier();
      await expect(diff.link).toHaveCount(0);

      await diff.cmdClick(DOUBLED_LINE, "addNumbers");
      const editor = new FileViewerPage(page, page.getByTestId("center-file-leaf__visible-true"));
      await editor.expectContent(ADD_NUMBERS_DEF);
      await expect(editor.symbols.line(ADD_NUMBERS_DEF)).toBeInViewport();

      // The editor draws the same link.
      await editor.symbols.cmdHover(ADD_NUMBERS_DEF, "addNumbers");
      await editor.symbols.expectLinkOn("addNumbers");
      const editorColours = await editor.symbols.linkColours();
      for (const colour of editorColours.actual) expect(colour).toBe(editorColours.expected);
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
    await expect(diff.line(LOCAL_HELPER_DEF)).not.toBeInViewport();

    await diff.cmdHover(DOUBLED_LINE, "localHelper");
    await diff.expectLinkOn("localHelper");
    await diff.releaseModifier();
    await diff.cmdClick(DOUBLED_LINE, "localHelper");

    await expect(diff.line(LOCAL_HELPER_DEF)).toBeInViewport();
    await expect(changes.diffLeaf).toBeVisible();
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

    // ...the merge-base side does not, and Cmd+Click there opens nothing.
    const oldSide = changes.symbols("old");
    await oldSide.cmdHover(TOTAL_LINE, "addNumbers");
    await expect(oldSide.link).toHaveCount(0);
    await oldSide.releaseModifier();
    await oldSide.cmdClick(TOTAL_LINE, "addNumbers");
    await expect(changes.diffLeaf).toBeVisible();

    // Positive anchor: the same click on the working-tree side does navigate.
    await newSide.cmdClick(TOTAL_LINE, "addNumbers");
    const editor = new FileViewerPage(page, page.getByTestId("center-file-leaf__visible-true"));
    await editor.expectContent(ADD_NUMBERS_DEF);
  });
});
