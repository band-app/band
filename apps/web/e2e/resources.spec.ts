/**
 * End-to-end coverage for issue #506 — the Resources dialog.
 *
 * Boots the production server bundle against a fresh tmp `~/.band/`,
 * seeds a real git repo + worktree with a known-size file, then drives
 * the React UI through `ResourcesPage` (page-object model). The page
 * is no longer a separate route — it lives inside a Radix Dialog
 * opened from the dashboard's overflow menu.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ResourcesPage } from "./pages/ResourcesPage";

const TOKEN = "e2e-resources-page-token";

const PROJECT = "resources-fixture";
const BRANCH = "main";
// 1 MiB of zero bytes — well above the page's `formatBytes` rounding
// boundary, so the rendered "Total size" cell unambiguously reports
// MB-class output.
const SEED_FILE_BYTES = 1024 * 1024;

// Wide viewport so the AppShell renders the desktop title bar (which
// is where the dashboard menu trigger lives).
test.use({ viewport: { width: 1280, height: 800 } });

// Definite-assignment in `beforeAll`. The `typeof` guard in
// `afterAll` covers the only path that could leave it unassigned:
// `startServer` throwing before resolving. Without the guard, an
// unrelated `TypeError: Cannot read properties of undefined
// (reading 'close')` would mask the real boot failure.
let server!: ServerHandle;
let tmpHome: string;
let projectPath: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // Initialize a real git repo so `listWorktrees` returns a real row
  // pointing at the seeded path. The page walks this directory and
  // sums file sizes — the 1 MiB seed file is the lower bound the
  // assertion below uses.
  projectPath = join(tmpHome, PROJECT);
  mkdirSync(projectPath, { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch", BRANCH], {
    cwd: projectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], {
    cwd: projectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "E2E"], {
    cwd: projectPath,
    stdio: "ignore",
  });
  writeFileSync(join(projectPath, "seed.bin"), Buffer.alloc(SEED_FILE_BYTES));
  execFileSync("git", ["add", "."], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "seed"], {
    cwd: projectPath,
    stdio: "ignore",
  });

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: projectPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: projectPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (typeof server !== "undefined") await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Resources dialog (issue #506)", () => {
  test("loads server snapshot and worktree usage from the dashboard menu", async ({ page }) => {
    const resources = new ResourcesPage(page, server.url, TOKEN);

    await resources.open();
    await resources.waitForReady();

    // Server card: numeric PID present.
    const pid = await resources.getServerPidValue();
    expect(Number.isFinite(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);

    // Worktrees card: the project row appears immediately on open
    // (no Refresh click needed). The per-project size cell starts
    // as a "measuring…" spinner and resolves to MB-class output
    // when the server's `du` finishes.
    const projectRow = resources.getProjectRow(PROJECT);
    await expect(projectRow).toBeVisible({ timeout: 15_000 });
    const sizeCell = resources.getProjectSize(PROJECT);
    await expect(sizeCell).toContainText(/MB/, { timeout: 15_000 });
    await expect(resources.projectsTotal).toContainText(/MB/);

    // Per-worktree breakdown is hidden behind a click on the project
    // row. Positive anchor first: confirm the table itself has
    // rendered (so a missing testid distinguishes "row hidden" from
    // "page never loaded"). Then assert the worktree row is NOT
    // in the DOM, expand the project, and assert it appears with
    // its branch + size.
    await expect(resources.projectsTable).toBeVisible();
    const worktreeRow = resources.getWorktreeRow(PROJECT, BRANCH);
    await expect(worktreeRow).not.toBeVisible();
    await resources.expandProject(PROJECT);
    await expect(worktreeRow).toBeVisible();
    await expect(worktreeRow).toContainText(/MB/);
  });
});
