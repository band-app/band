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
 * The language server is real: the worktree lives on a real `band-worker`, a
 * `typescript-lsp` extension is installed on the hub (`hub/tests/helpers/lsp-extension.ts`),
 * and the fixture repo's `node_modules` links to the `typescript` package this
 * app installs. Nothing in Band is mocked; the worker spawns the language
 * server as it does for a user.
 */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { createTsLspRepo } from "../../hub/tests/fixtures/ts-lsp-repo";
import { installTsLsp, waitForLanguageServer } from "../../hub/tests/helpers/lsp-extension";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedHostWorktree,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutateData } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { ChangesPanelPage } from "./pages/ChangesPanelPage";

// Wide enough for the desktop layout and a side-by-side split.
test.use({ viewport: { width: 1800, height: 800 } });

const TOKEN = "e2e-diff-lsp-navigation-token";
const REPO_NAME = "lsp-diff-repo";
const HOST_ID = "h-lspdiff";
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

interface ServerContext {
  server: ServerHandle;
  tmpHome: string;
  worktreeId: string;
  /** The fixture repo's one commit. */
  commitSha: string;
  worker?: WorkerHandle;
  workerDirs: string[];
}

function bootServer(theme: "light" | "dark"): ServerContext {
  const ctx: ServerContext = {
    server: undefined as unknown as ServerHandle,
    tmpHome: "",
    worktreeId: toWorktreeId(REPO_NAME, BRANCH, HOST_ID),
    commitSha: "",
    workerDirs: [],
  };
  test.beforeAll(async () => {
    ctx.tmpHome = createTmpHome();
    const repoPath = join(ctx.tmpHome, REPO_NAME);
    ctx.commitSha = createTsLspRepo({
      repoPath,
      branch: BRANCH,
      committed: { "src/math.ts": MATH_TS, "src/main.ts": MAIN_BEFORE },
      working: { "src/main.ts": MAIN_AFTER },
    });
    seedState(ctx.tmpHome, {
      repos: [
        {
          name: REPO_NAME,
          path: repoPath,
          defaultBranch: BRANCH,
          worktrees: [],
        },
      ],
    });
    seedSettings(ctx.tmpHome, { tokenSecret: TOKEN, enableLSP: true, theme });
    ctx.server = await startServer({ tmpHome: ctx.tmpHome });
    // The worktree lives on a worker, which runs the language server. Its root holds the repo.
    const issued = await trpcMutateData<{ token: string }>(
      ctx.server.url,
      TOKEN,
      "tokens.issueWorkerBootstrap",
      { hostName: "lsp-worker", labels: [], hostId: HOST_ID },
    );
    const dir = (prefix: string) => {
      const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      ctx.workerDirs.push(d);
      return d;
    };
    ctx.worker = startWorker({
      env: {
        BAND_HUB_URL: ctx.server.url,
        BAND_BOOTSTRAP_TOKEN: issued.token,
        BAND_WORKER_ID: HOST_ID,
      },
      root: ctx.tmpHome,
      stateDir: dir("band-e2e-lsp-state-"),
      home: dir("band-e2e-lsp-home-"),
    });
    await installTsLsp(ctx.server.url, TOKEN);
    await waitForLanguageServer(ctx.server.url, TOKEN, HOST_ID);
    seedHostWorktree(ctx.tmpHome, {
      repo: REPO_NAME,
      name: BRANCH,
      branch: BRANCH,
      path: repoPath,
      hostId: HOST_ID,
    });
    // The hub also lists its own checkout of the default branch. The worker's copy is the one shown.
    await trpcMutateData(ctx.server.url, TOKEN, "repos.update", {
      name: REPO_NAME,
      primaryHostId: HOST_ID,
    });
  });
  // UI state lives on the server now: start each test from none, like the
  // fresh localStorage each test's browser context used to give it.
  test.beforeEach(() => resetClientState(ctx.tmpHome));

  test.afterAll(async () => {
    await ctx.worker?.kill();
    if (ctx.server) await ctx.server.close();
    for (const d of ctx.workerDirs) cleanupTmpHome(d);
    if (ctx.tmpHome) cleanupTmpHome(ctx.tmpHome);
  });
  return ctx;
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`diff go-to-definition (${theme} theme)`, () => {
    const ctx = bootServer(theme);
    if (theme === "light") registerNavigationTests(ctx);

    test("Cmd+hover links a symbol in the link colour, Cmd+Click opens its definition in another file", async ({
      page,
    }) => {
      const changes = new ChangesPanelPage(page, ctx.server.url, TOKEN);
      await changes.goto(ctx.worktreeId);
      await changes.openDiff("src/main.ts", "unified");
      const diff = changes.symbols("new");

      await diff.cmdHover(DOUBLED_LINE, "addNumbers");
      await diff.expectLinkOn("addNumbers");
      // The whole symbol, including any highlighted span inside the link.
      await expect.poll(() => diff.linkColours()).toEqual([LINK_COLOUR[theme]]);
      await diff.releaseModifier();
      await expect(diff.link).toHaveCount(0);

      await diff.cmdClick(DOUBLED_LINE, "addNumbers");
      const editor = changes.openedEditor;
      await editor.expectContent(ADD_NUMBERS_DEF);
      await expect(editor.symbols.line(ADD_NUMBERS_DEF)).toBeInViewport();

      // The editor draws the same link.
      await editor.symbols.cmdHover(ADD_NUMBERS_DEF, "addNumbers");
      await editor.symbols.expectLinkOn("addNumbers");
      await expect.poll(() => editor.symbols.linkColours()).toEqual([LINK_COLOUR[theme]]);
      await editor.symbols.releaseModifier();
    });
  });
}

/** Theme-independent cases, run against the light-theme server. */
function registerNavigationTests(ctx: ServerContext) {
  test("Cmd+Click on a symbol defined in the same file scrolls the diff to it", async ({
    page,
  }) => {
    const changes = new ChangesPanelPage(page, ctx.server.url, TOKEN);
    await changes.goto(ctx.worktreeId);
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
    await changes.goto(ctx.worktreeId);
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
    await changes.goto(ctx.worktreeId);
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
    await changes.goto(ctx.worktreeId);
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
    await changes.goto(ctx.worktreeId);
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

  test("A commit's diff is not linked: its text is that commit's file, not the working tree", async ({
    page,
  }) => {
    const changes = new ChangesPanelPage(page, ctx.server.url, TOKEN);
    await changes.goto(ctx.worktreeId);

    // Positive anchor: the same line links in the working-tree diff.
    await changes.openDiff("src/main.ts", "unified");
    const diff = changes.symbols("new");
    await diff.cmdHover(TOTAL_LINE, "addNumbers");
    await diff.expectLinkOn("addNumbers");
    await diff.releaseModifier();

    await changes.expandCommit(ctx.commitSha);
    await changes.openCommitFile(ctx.commitSha, "src/main.ts");
    await expect(changes.diffTab("src/main.ts")).toHaveAttribute("data-commit", ctx.commitSha);
    const commitDiff = changes.symbols("new");
    await commitDiff.cmdHover(TOTAL_LINE, "addNumbers");
    await commitDiff.expectNoLinkFor();
    await commitDiff.releaseModifier();
  });
}
