/**
 * End-to-end coverage for the diff leaf's overview ruler: the strip down the
 * right edge of the diff that marks where the added, removed and modified
 * lines sit in the file, VS Code style, and jumps to a change on click.
 *
 * The fixture is a 300-line file with one change of each kind, far apart:
 * lines added near the top, a line modified in the middle, and lines removed
 * near the bottom. The diff leaf renders the whole file (full-file context),
 * so the ruler has to place the three markers top-to-bottom in that order,
 * and clicking the bottom marker has to scroll the diff down to it.
 *
 * Drives a real Band server against an on-disk repo, so the diff reaches
 * CodeMirror through the production git pipeline. Locators live in
 * `pages/ChangesPanelPage.ts`.
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
import { ChangesPanelPage, type DiffViewMode } from "./pages/ChangesPanelPage";

// Wide enough for `useIsDesktop()` and a real side-by-side split; short
// enough that the 300-line file overflows the diff leaf.
test.use({ viewport: { width: 2000, height: 800 } });

const TOKEN = "e2e-diff-ruler-token";
const REPO_NAME = "ruler-repo";
const BRANCH = "main";
const FILE_PATH = "long-file.txt";

const ORIGINAL_LINES = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
// Two lines added after line 10, line 150 modified, lines 280-284 removed.
const MODIFIED_LINES = [
  ...ORIGINAL_LINES.slice(0, 10),
  "added line A",
  "added line B",
  ...ORIGINAL_LINES.slice(10, 149),
  "line 150 (modified)",
  ...ORIGINAL_LINES.slice(150, 279),
  ...ORIGINAL_LINES.slice(284),
];

let server: ServerHandle;
let tmpHome: string;
let workspaceId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });

  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, FILE_PATH), `${ORIGINAL_LINES.join("\n")}\n`);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  writeFileSync(join(repoPath, FILE_PATH), `${MODIFIED_LINES.join("\n")}\n`);

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
  cleanupTmpHome(tmpHome);
});

for (const mode of ["unified", "split"] satisfies DiffViewMode[]) {
  test(`Overview ruler marks each change and jumps to it (${mode} mode)`, async ({ page }) => {
    const changes = new ChangesPanelPage(page, server.url, TOKEN);
    await changes.goto(workspaceId);
    await changes.openDiff(FILE_PATH, mode);

    await expect(changes.rulerMarkers("added")).toHaveCount(1);
    await expect(changes.rulerMarkers("modified")).toHaveCount(1);
    await expect(changes.rulerMarkers("removed")).toHaveCount(1);

    // The markers follow the changes' order in the file: added near the top,
    // modified in the middle, removed near the bottom. Polled because the
    // ruler re-measures as CodeMirror settles its line heights.
    await expect(async () => {
      const [added] = await changes.rulerMarkerCenters("added");
      const [modified] = await changes.rulerMarkerCenters("modified");
      const [removed] = await changes.rulerMarkerCenters("removed");
      expect(added).toBeLessThan(modified);
      expect(modified).toBeLessThan(removed);
    }).toPass();

    await expect(changes.diffLine("line 279")).not.toBeInViewport();

    // Clicking the bottom marker scrolls the diff down to the removed lines.
    await changes.clickRulerMarker("removed");
    await expect(changes.diffLine("line 279")).toBeInViewport();
    await expect(changes.diffLine("added line A")).not.toBeInViewport();

    // Clicking the top marker scrolls back up to the added lines.
    await changes.clickRulerMarker("added");
    await expect(changes.diffLine("added line A")).toBeInViewport();
  });
}

test("Overview ruler scrolls the diff by slider drag and track click", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaceId);
  await changes.openDiff(FILE_PATH, "unified");
  await expect(changes.rulerMarkers("removed")).toHaveCount(1);
  expect(await changes.diffScrollTop()).toBe(0);

  // Dragging the slider down scrolls the diff down.
  await changes.dragRulerSlider(100);
  await expect.poll(() => changes.diffScrollTop()).toBeGreaterThan(0);

  // A click on empty track, between the modified and removed markers, centers
  // the view on that spot of the file rather than jumping to a marker.
  const fraction = 0.75;
  await changes.clickRulerTrack(fraction);
  const { scrollHeight, clientHeight } = await changes.diffScrollRange();
  const expected = fraction * scrollHeight - clientHeight / 2;
  await expect
    .poll(async () => Math.abs((await changes.diffScrollTop()) - expected))
    .toBeLessThan(clientHeight / 10);
});
