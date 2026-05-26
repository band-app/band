/**
 * End-to-end coverage for the mount-once policy in DiffView's `LazyFileRow`.
 *
 * Before this change, each row's CodeMirror editor was torn down whenever
 * the row scrolled outside the IntersectionObserver's 800-px rootMargin
 * zone and re-mounted on return — paying the `loadLanguage` + new
 * MergeView + first-paint cost every time, with a one-frame flicker
 * between placeholder and re-mounted editor. The new policy keeps any
 * editor that has been scrolled into view alive for the rest of the
 * workspace session (bounded by `MAX_MOUNTED_EDITORS` in DiffView), so
 * subsequent scroll-backs hit the same DOM instance with no re-mount.
 *
 * Test shape:
 *  1. Create a real git repo with a small file ("a.txt") and a tall file
 *     ("b-spacer.txt") whose diff is large enough to push a.txt well
 *     outside the 800-px IO zone when scrolled past.
 *  2. Open the workspace's Changes panel with expand-all on, so both
 *     files mount automatically as the user scrolls.
 *  3. Tag a.txt's `.cm-editor` with a unique JS property on first paint.
 *  4. Scroll the diff scroller past b-spacer so a.txt is far above the
 *     viewport (well beyond the IO zone), then scroll back.
 *  5. Assert (a) the editor count stays at 2 across the scroll-away
 *     (so neither editor was torn down) and (b) the tag is still on the
 *     same `.cm-editor` element after scroll-back (DOM identity proof).
 *
 * Anti-pattern: do NOT assert on absolute pixel offsets or scroll
 * latency. Use `expect.poll` and DOM identity checks per the
 * `write-integration-test` skill. All locators / setup live in
 * `pages/ChangesPanelPage.ts` per the same doctrine.
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
import { ChangesPanelPage } from "./pages/ChangesPanelPage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-diff-mount-once-token";
const REPO_NAME = "mount-once-repo";
const BRANCH = "main";
const SMALL_FILE = "a.txt";
const SPACER_FILE = "b-spacer.txt";

// Tall enough diff that scrolling past it pushes `a.txt` well beyond
// the IO observer's 800-px rootMargin zone. 400 lines × ~16 px/line
// ≈ 6400 px — comfortable headroom over the threshold.
const SPACER_NEW_LINES = Array.from({ length: 400 }, (_, i) => `spacer line ${i}`).join("\n");

let server: ServerHandle;
let tmpHome: string;
let workspaceId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });

  // Two committed files; uncommitted modifications produce the diff
  // hunks the Changes panel renders. The diff for `a.txt` is short (one
  // line added) while `b-spacer.txt`'s is intentionally tall so it
  // dominates the scroll height.
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, SMALL_FILE), "original line\n");
  writeFileSync(join(repoPath, SPACER_FILE), "spacer original\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  // Modify both files so each has an uncommitted diff
  writeFileSync(join(repoPath, SMALL_FILE), "original line\nadded line\n");
  writeFileSync(join(repoPath, SPACER_FILE), `spacer original\n${SPACER_NEW_LINES}\n`);

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

test("LazyFileRow keeps the CodeMirror editor mounted across scroll-aways", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.openWorkspace(workspaceId, { expandAll: true });

  // Both file headers should be in the DOM (auto-expanded). Wait on
  // the spacer's row to ensure the summary fetch has resolved and the
  // file list is rendered.
  await expect(changes.fileRowButton(SPACER_FILE, "M")).toBeVisible({ timeout: 15_000 });
  await expect(changes.scroller).toBeVisible();

  // Wait for both editors to mount on first paint. With expand-all on
  // and the spacer being long, the first row's editor mounts immediately
  // (it intersects the viewport) and the spacer's mounts because its
  // top edge is inside the 800-px IO rootMargin.
  await expect(changes.cmEditors).toHaveCount(2, { timeout: 15_000 });

  // Tag the first file's editor (`a.txt` — alphabetical first per the
  // tree flatten order) with a stable marker so we can verify DOM
  // identity after a scroll dance. If the row's editor is destroyed
  // and re-mounted, the new `.cm-editor` element won't carry the
  // marker.
  await changes.tagFirstEditor("alive");

  // Scroll well past the spacer file so `a.txt`'s row is far above the
  // viewport (way beyond the 800-px IO rootMargin). 5000 px is plenty
  // — the spacer's editor body alone is ~6400 px tall.
  await changes.scrollTo(5000);

  // Wait for the IntersectionObserver to react to the scroll. The
  // observer fires asynchronously after the layout settles; polling
  // on `.cm-editor` count is deterministic because the count is a
  // direct effect of the IO callback. With mount-once, the count
  // stays at 2 (both editors alive) even when one row is far
  // outside the viewport. With the pre-mount-once behaviour the IO
  // would have torn down `a.txt`'s editor here, dropping the count
  // to 1 — so this is the assertion that catches the regression
  // most directly.
  await expect
    .poll(async () => await changes.mountedEditorCount(), {
      message: "editor count should stay at 2 across scroll-away (mount-once)",
      timeout: 5_000,
    })
    .toBe(2);

  // Belt-and-braces: the first editor's DOM element is STILL the one
  // we tagged at the start (same JS identity, not a freshly remounted
  // instance that happens to be at position 0 in the locator).
  expect(await changes.firstEditorMarker()).toBe("alive");

  // Scroll back to the top and confirm the marker is STILL the same
  // element we marked originally (not a freshly mounted instance).
  await changes.scrollTo(0);
  await expect
    .poll(async () => await changes.scrollTop(), {
      message: "scroller should have committed the scroll-back",
      timeout: 5_000,
    })
    .toBeLessThan(50);

  expect(await changes.firstEditorMarker()).toBe("alive");

  // Sanity: only two editors are mounted (one per file), so the LRU
  // cap is nowhere near triggered. This is a defensive check that
  // the test isn't accidentally exercising an eviction code path.
  await expect(changes.cmEditors).toHaveCount(2);
});
