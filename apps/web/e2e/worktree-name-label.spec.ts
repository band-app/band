/**
 * End-to-end coverage for the worktree `name` field (identity decoupled
 * from the live git branch).
 *
 * The repos-list card renders the immutable `name` — the branch the
 * worktree was created on — NOT the live git `branch`. So once a
 * worktree's git branch is switched, the sidebar label must stay put.
 * That is the user-observable payoff of the feature ("labels in the
 * repos list are changed" was the reported bug), so it gets a real
 * DOM assertion here.
 *
 * Architecture (mirrors `worktree-maximize-state.spec.ts`):
 *   - Real production binary against a fresh tmp `~/.band/`. No tRPC
 *     mocking; the dashboard renders against the real backend.
 *   - A repo with a divergent worktree is seeded straight into SQLite
 *     with `name: "feature"` but `branch: "feature-renamed"` (the seed
 *     helper supports an explicit `name` distinct from `branch`). The
 *     path is a fake `/tmp/fake/...` dir — `git worktree list` fails
 *     gracefully and `repos.list` falls back to the tracked rows,
 *     which already carry `name`, so no real git repo is needed.
 *   - All UI is driven through `WorktreePage` (no raw `getByTestId` /
 *     `page.goto` in the test body).
 */

import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-worktree-name-label-token";

const REPO = "name-label-proj";
// The worktree was created on branch "feature" (its frozen `name`) and
// later switched to "feature-renamed" (its live `branch`).
const NAME = "feature";
const LIVE_BRANCH = "feature-renamed";
const FEATURE_WORKTREE = toWorktreeId(REPO, NAME);
const MAIN_WORKTREE = toWorktreeId(REPO, "main");
// The id must NOT follow the branch — this worktree should never exist.
const BRANCH_WORKTREE = toWorktreeId(REPO, LIVE_BRANCH);

// Wide viewport so the desktop layout (with the sidebar repo list) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: `/tmp/fake/${REPO}`,
        defaultBranch: "main",
        worktrees: [
          { name: "main", branch: "main", path: `/tmp/fake/${REPO}` },
          // Divergent: identity frozen at "feature", live branch switched.
          { name: NAME, branch: LIVE_BRANCH, path: `/tmp/fake/${REPO}/${NAME}` },
        ],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Worktree name label (identity decoupled from git branch)", () => {
  test("sidebar card shows the stable name, not the switched git branch", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    // Land on the main worktree so the sidebar repo list renders.
    await worktreePage.goto(MAIN_WORKTREE);

    // The card is keyed by the id derived from `name`, so it exists at
    // `proj-feature` and never at `proj-feature-renamed`.
    const featureCard = worktreePage.worktreeCard(FEATURE_WORKTREE);
    await expect(featureCard).toBeVisible();
    await expect(worktreePage.worktreeCard(BRANCH_WORKTREE)).toHaveCount(0);

    // The visible label is the frozen `name`; the switched git branch
    // must not appear anywhere on the card.
    await expect(featureCard).toContainText(NAME);
    await expect(featureCard).not.toContainText(LIVE_BRANCH);
  });
});
