/**
 * End-to-end coverage for issue #506 — the Resources dialog.
 *
 * Boots the production server bundle against a fresh tmp `~/.band/`,
 * seeds a real git repo + worktree with a known-size file, then drives
 * the React UI through `ResourcesPage` (page-object model). The page
 * is no longer a separate route — it lives inside a Radix Dialog
 * opened from the dashboard's overflow menu.
 *
 * Out of scope: the "Desktop app (Electron)" card
 * ------------------------------------------------
 * `ElectronCard` in `ResourcesPage.tsx` self-gates on `isDesktop`
 * (`if (!isDesktop) return null`) and pulls its data over the Electron
 * IPC bridge (`invoke("get_app_metrics")`). This web-build harness
 * never boots Electron, so `window.__BAND_DESKTOP__` is absent and the
 * card is never rendered — a runtime regression catch for it requires
 * desktop e2e coverage this spec can't provide (same shape and
 * rationale as the browser-panel / macOS-shell IPC surfaces). We do
 * assert the negative below (`electronCard` has zero DOM nodes) so the
 * self-gate has an empirical check on the web path.
 *
 * Only the data-mapping layer is unit-tested (`mapAppMetrics` in
 * `apps/desktop/tests/app-metrics.test.ts`). The IPC channel
 * registration (`register.ts`), the preload allowlist entry
 * (`index.cts`), and the `ElectronCard` React rendering remain
 * uncovered, pending desktop e2e infrastructure.
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

    // Cards start collapsed. Prove the collapsed-state UI rendered
    // first — each card shows its headline total next to the title —
    // then assert the expanded-state body content (server PID, project
    // table) is not mounted.
    await expect(resources.serverTotal).toBeVisible();
    await expect(resources.worktreesTotal).toBeVisible();
    await expect(resources.serverPid).not.toBeVisible();
    await expect(resources.projectsTable).not.toBeVisible();

    // The Electron card is desktop-only (self-gates on isDesktop) and
    // never renders in this web-build harness — see the scope note at
    // the top of this file.
    await expect(resources.electronCard).toHaveCount(0);

    // Server card: expand it, then assert a numeric PID is present.
    await resources.expandServer();
    const pid = await resources.getServerPidValue();
    expect(Number.isFinite(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);

    // Worktrees card: expand it, then the project row appears (no
    // Refresh click needed). The per-project size cell starts as a
    // "measuring…" spinner and resolves to MB-class output when the
    // server's `du` finishes.
    await resources.expandWorktrees();
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
