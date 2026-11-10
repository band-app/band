/**
 * Opening files that live on this Mac in the desktop app: the OS handing the app a path (Finder's
 * Open With) and dragging files from the file manager onto a tab strip.
 *
 * The REAL Electron app is launched against a throwaway HOME with a real local hub. Test
 * boundary: the Finder menu entry is a LaunchServices UI that cannot be automated, so the
 * `open-file` event macOS sends is emitted on the app object. A real Finder drag cannot be
 * automated either: the drag events are dispatched on the page, but the `File` objects come
 * from a file input filled by Playwright, so `webUtils.getPathForFile` returns real paths.
 * Dropping a folder is not covered (an input cannot hold one).
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  getRandomPort,
  seedSettings,
  seedState,
} from "../e2e/helpers/server";
import { type LaunchedDesktop, launchDesktop } from "./helpers/desktop-app";
import { DesktopDashboardPage } from "./pages/DesktopDashboardPage";

const TOKEN = "desktop-open-files-token";
const WORKTREE_A = toWorktreeId("alpha", "main", "local");
const WORKTREE_B = toWorktreeId("beta", "main", "local");

const homes: string[] = [];
let desktop: LaunchedDesktop | null = null;

test.afterEach(async () => {
  await desktop?.close();
  desktop = null;
});
test.afterAll(() => {
  for (const home of homes) cleanupTmpHome(home);
});

interface World {
  home: string;
  port: number;
  repoA: string;
  repoB: string;
  /** A directory outside every worktree. */
  outside: string;
}

async function seedWorld(): Promise<World> {
  const home = realpathSync(createTmpHome());
  homes.push(home);
  const repoA = join(home, "alpha");
  const repoB = join(home, "beta");
  const outside = join(home, "outside");
  for (const dir of [repoA, repoB, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(repoA, "a.txt"), "alpha file\n");
  writeFileSync(join(repoB, "b.ts"), "export const fromBeta = 1;\n");
  writeFileSync(join(outside, "notes.ts"), "export const outsideMarker = 1;\n");
  writeFileSync(join(outside, "one.txt"), "dropped one\n");
  writeFileSync(join(outside, "doc.pdf"), "%PDF-1.1\n%%EOF\n");
  writeFileSync(
    join(outside, "page.html"),
    '<!doctype html><link rel="stylesheet" href="style.css"><h1>Local page</h1>\n',
  );
  writeFileSync(join(outside, "style.css"), "h1 { color: rgb(0, 128, 0); }\n");
  writeFileSync(join(outside, "two.txt"), "dropped two\n");
  seedState(home, {
    repos: [
      {
        name: "alpha",
        path: repoA,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoA }],
      },
      {
        name: "beta",
        path: repoB,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoB }],
      },
    ],
  });
  const port = await getRandomPort();
  seedSettings(home, { tokenSecret: TOKEN, webServerPort: port });
  return { home, port, repoA, repoB, outside };
}

async function launch(
  world: World,
  openFilesBeforeUi?: string[],
): Promise<{ dashboard: DesktopDashboardPage; app: LaunchedDesktop }> {
  desktop = await launchDesktop({
    home: world.home,
    hubPort: world.port,
    openFilesBeforeUi,
  });
  // Docked DevTools take much of the page's width and squeeze the editor under the side panels.
  await desktop.closeDevTools();
  const dashboard = new DesktopDashboardPage(desktop.window);
  await dashboard.expectRepoListed("alpha");
  return { dashboard, app: desktop };
}

test("S4: a file outside every worktree opens as an editable tab in the current worktree and saves", async () => {
  const world = await seedWorld();
  const { dashboard, app } = await launch(world);
  await dashboard.openWorktree(WORKTREE_A);

  const path = join(world.outside, "notes.ts");
  await app.emitOpenFile(path);

  await expect(dashboard.localFileTab(path)).toBeVisible({ timeout: 30_000 });
  await dashboard.fileViewer.expectContent("outsideMarker");
  await dashboard.fileViewer.typeAtStart("// saved by Band\n");
  await dashboard.fileViewer.saveWithShortcut();
  await dashboard.fileViewer.expectSaved();
  await expect
    .poll(() => readFileSync(path, "utf-8"))
    .toBe("// saved by Band\nexport const outsideMarker = 1;\n");
});

test("S5: a file inside another worktree on this Mac switches there and opens a normal tab", async () => {
  const world = await seedWorld();
  const { dashboard, app } = await launch(world);
  await dashboard.openWorktree(WORKTREE_A);

  await app.emitOpenFile(join(world.repoB, "b.ts"));

  await expect.poll(() => dashboard.url()).toContain(encodeURIComponent(WORKTREE_B));
  await expect(dashboard.fileTab("b.ts")).toBeVisible({ timeout: 30_000 });
  await dashboard.fileViewer.expectContent("fromBeta");
});

test("S4 cold start: a path handed over before the UI loaded still opens", async () => {
  const world = await seedWorld();
  const { dashboard } = await launch(world, [join(world.repoA, "a.txt")]);

  await expect(dashboard.fileTab("a.txt")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => dashboard.url()).toContain(encodeURIComponent(WORKTREE_A));
});

test("S7: files dropped on the tab strip each open in a new tab", async () => {
  const world = await seedWorld();
  const { dashboard } = await launch(world);
  await dashboard.openWorktree(WORKTREE_A);

  const one = join(world.outside, "one.txt");
  const two = join(world.outside, "two.txt");
  await dashboard.tabStrip.startFileDrag([one, two]);
  expect(await dashboard.tabStrip.dropOnStrip()).toBe(true);

  await expect(dashboard.localFileTab(one)).toBeVisible({ timeout: 30_000 });
  await expect(dashboard.localFileTab(two)).toBeVisible({ timeout: 30_000 });
});

test("S6: a PDF and an HTML file from this Mac preview, the HTML with its stylesheet", async () => {
  const world = await seedWorld();
  const { dashboard, app } = await launch(world);
  await dashboard.openWorktree(WORKTREE_A);

  const pdf = join(world.outside, "doc.pdf");
  await app.emitOpenFile(pdf);
  await expect(dashboard.localFileTab(pdf)).toBeVisible({ timeout: 30_000 });
  await expect(dashboard.fileViewer.pdfFrame).toBeVisible({ timeout: 30_000 });
  // The page's CSP allows a blob: frame but not a fetch of it, so the source is checked, not the bytes.
  expect(await dashboard.fileViewer.pdfFrame.getAttribute("src")).toMatch(/^blob:/);

  const html = join(world.outside, "page.html");
  await app.emitOpenFile(html);
  await expect(dashboard.localFileTab(html)).toBeVisible({ timeout: 30_000 });
  await dashboard.fileViewer.showHtmlPreview();
  const heading = dashboard.fileViewer.externalHtmlHeading("Local page");
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await expect(heading).toHaveCSS("color", "rgb(0, 128, 0)");
});
