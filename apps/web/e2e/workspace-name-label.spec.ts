/**
 * End-to-end coverage for the workspace `name` field (identity decoupled
 * from the live git branch).
 *
 * The projects-list card renders the immutable `name` — the branch the
 * workspace was created on — NOT the live git `branch`. So once a
 * workspace's git branch is switched, the sidebar label must stay put.
 * That is the user-observable payoff of the feature ("labels in the
 * projects list are changed" was the reported bug), so it gets a real
 * DOM assertion here.
 *
 * Architecture (mirrors `workspace-maximize-state.spec.ts`):
 *   - Real production binary against a fresh tmp `~/.band/`. No tRPC
 *     mocking; the dashboard renders against the real backend.
 *   - A project with a divergent worktree is seeded straight into SQLite
 *     with `name: "feature"` but `branch: "feature-renamed"` (the seed
 *     helper supports an explicit `name` distinct from `branch`). The
 *     path is a fake `/tmp/fake/...` dir — `git worktree list` fails
 *     gracefully and `projects.list` falls back to the tracked rows,
 *     which already carry `name`, so no real git repo is needed.
 *   - All UI is driven through `WorkspacePage` (no raw `getByTestId` /
 *     `page.goto` in the test body).
 */

import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-workspace-name-label-token";

const PROJECT = "name-label-proj";
// The workspace was created on branch "feature" (its frozen `name`) and
// later switched to "feature-renamed" (its live `branch`).
const NAME = "feature";
const LIVE_BRANCH = "feature-renamed";
const FEATURE_WORKSPACE = toWorkspaceId(PROJECT, NAME);
const MAIN_WORKSPACE = toWorkspaceId(PROJECT, "main");
// The id must NOT follow the branch — this workspace should never exist.
const BRANCH_WORKSPACE = toWorkspaceId(PROJECT, LIVE_BRANCH);

// Wide viewport so the desktop layout (with the sidebar project list) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: `/tmp/fake/${PROJECT}`,
        defaultBranch: "main",
        worktrees: [
          { name: "main", branch: "main", path: `/tmp/fake/${PROJECT}` },
          // Divergent: identity frozen at "feature", live branch switched.
          { name: NAME, branch: LIVE_BRANCH, path: `/tmp/fake/${PROJECT}/${NAME}` },
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

test.describe("Workspace name label (identity decoupled from git branch)", () => {
  test("sidebar card shows the stable name, not the switched git branch", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Land on the main workspace so the sidebar project list renders.
    await workspacePage.goto(MAIN_WORKSPACE);

    // The card is keyed by the id derived from `name`, so it exists at
    // `proj-feature` and never at `proj-feature-renamed`.
    const featureCard = workspacePage.workspaceCard(FEATURE_WORKSPACE);
    await expect(featureCard).toBeVisible();
    await expect(workspacePage.workspaceCard(BRANCH_WORKSPACE)).toHaveCount(0);

    // The visible label is the frozen `name`; the switched git branch
    // must not appear anywhere on the card.
    await expect(featureCard).toContainText(NAME);
    await expect(featureCard).not.toContainText(LIVE_BRANCH);
  });
});
