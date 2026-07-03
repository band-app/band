/**
 * Page object for the Resources dialog opened from the dashboard
 * title-bar menu (no dedicated route — the page renders inside a
 * shared Dialog managed by `ToolbarOverflowProvider`).
 *
 * Owns the locators for the server snapshot card and the worktree
 * usage table, plus a `goto()` that walks the user flow:
 * dashboard → Menu → Resources.
 *
 * Locator priority:
 *
 *   - `getByRole({ name })` for the dashboard title bar Menu trigger
 *     (the `aria-label="Menu"` value is system-controlled and not
 *     localisable user copy).
 *   - `getByTestId(...)` for owned card / button / table elements,
 *     using the BEM-style `resources-*` prefix the page component sets
 *     in `ResourcesPage.tsx`, plus `menu__resources` for the menu item
 *     and `resources-dialog` for the dialog body itself.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class ResourcesPage {
  /** The Radix Dialog body wrapping the page. Used as the
   *  "the dialog opened" visibility anchor. */
  readonly dialog: Locator;
  /** Outer server snapshot card (PID, uptime, memory, CPU). */
  readonly serverCard: Locator;
  /** Title-row trigger that expands/collapses the server card. */
  readonly serverToggle: Locator;
  /** Headline total shown next to the server title while collapsed
   *  (the process RSS). Absent from the DOM once the card is open. */
  readonly serverTotal: Locator;
  /** PID cell inside the server card — primary "the snapshot loaded"
   *  assertion target. Only mounted while the card is expanded. */
  readonly serverPid: Locator;
  /** Title-row trigger that expands/collapses the worktrees card. */
  readonly worktreesToggle: Locator;
  /** Headline total shown next to the worktrees title while collapsed. */
  readonly worktreesTotal: Locator;
  /** Refresh button on the server card. */
  readonly refreshServerButton: Locator;
  /** Refresh button on the worktrees card. */
  readonly refreshWorktreesButton: Locator;
  /** Per-project table. The single rendered table — project rows
   *  are the top level, expanding a project reveals its worktrees
   *  as child rows in the same grid. */
  readonly projectsTable: Locator;
  /** Grand-total cell inside the per-project rollup's footer. */
  readonly projectsTotal: Locator;
  /** Menu trigger button in the desktop title bar. */
  readonly menuTrigger: Locator;
  /** Resources entry inside the dashboard menu. */
  readonly resourcesMenuItem: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByTestId("resources-dialog");
    this.serverCard = page.getByTestId("resources-server-card");
    this.serverToggle = page.getByTestId("resources-server-toggle");
    this.serverTotal = page.getByTestId("resources-server-total");
    this.serverPid = page.getByTestId("resources-server-pid");
    this.worktreesToggle = page.getByTestId("resources-worktrees-toggle");
    this.worktreesTotal = page.getByTestId("resources-worktrees-total");
    this.refreshServerButton = page.getByTestId("resources-refresh-server");
    this.refreshWorktreesButton = page.getByTestId("resources-refresh-worktrees");
    this.projectsTable = page.getByTestId("resources-projects-table");
    this.projectsTotal = page.getByTestId("resources-projects-total");
    // The desktop title bar exposes its hamburger trigger with
    // `aria-label="Menu"` (see DesktopTitleBar.tsx). System-controlled
    // ARIA name — getByRole is the preferred locator.
    this.menuTrigger = page.getByRole("button", { name: "Menu" });
    this.resourcesMenuItem = page.getByTestId("menu__resources");
  }

  /** Navigate to the dashboard root, then open the title-bar Menu and
   *  click Resources. Mirrors the user flow described in the issue.
   *
   *  Radix's DropdownMenuTrigger sometimes swallows the first click
   *  that lands on it inside `asChild` button wrappers during a fast
   *  Playwright run — the trigger's mousedown handler fires before
   *  the click's pointerdown bubbles back up, and the dropdown closes
   *  again. Polling the menu item's visibility via `expect.poll` lets
   *  us re-click the trigger until the dropdown stays open. */
  async open(): Promise<void> {
    await test.step("Open Resources via dashboard menu", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await expect(this.menuTrigger).toBeVisible();
      await expect
        .poll(
          async () => {
            await this.menuTrigger.click();
            return await this.resourcesMenuItem.isVisible().catch(() => false);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      await this.resourcesMenuItem.click();
      await expect(this.dialog).toBeVisible();
    });
  }

  /** Wait for the initial page render. All cards start collapsed, so
   *  the server card's header (its expand trigger) is the first
   *  reliable "the page mounted" anchor — the PID cell only mounts
   *  once the card is expanded. */
  async waitForReady(): Promise<void> {
    await expect(this.serverToggle).toBeVisible({ timeout: 15_000 });
  }

  /** Expand the (collapsed-by-default) server card and wait for its
   *  body to mount. The PID cell only renders once the snapshot query
   *  has resolved, so this doubles as the "snapshot loaded" wait. */
  async expandServer(): Promise<void> {
    await test.step("Expand the server card", async () => {
      await this.serverToggle.click();
      await expect(this.serverPid).toBeVisible({ timeout: 15_000 });
    });
  }

  /** Expand the (collapsed-by-default) worktrees card and wait for its
   *  table to mount. */
  async expandWorktrees(): Promise<void> {
    await test.step("Expand the worktrees card", async () => {
      await this.worktreesToggle.click();
      await expect(this.projectsTable).toBeVisible({ timeout: 15_000 });
    });
  }

  /** Trigger a server-card refresh. */
  async clickRefreshServer(): Promise<void> {
    await test.step("Click Refresh on the server card", async () => {
      await this.refreshServerButton.click();
    });
  }

  /** Trigger a worktree-usage refresh. */
  async clickRefreshWorktrees(): Promise<void> {
    await test.step("Click Refresh on the worktrees card", async () => {
      await this.refreshWorktreesButton.click();
    });
  }

  /** Locate the table row for a specific worktree by project +
   *  branch. Worktree rows are only rendered when their parent
   *  project row has been expanded (clicked). The component
   *  composes the testid from both parts so that two projects with
   *  the same branch (`main`) don't produce duplicate testids —
   *  mirror the sanitisation here so the page object can be called
   *  with raw values. */
  getWorktreeRow(project: string, branch: string): Locator {
    const safe = (s: string) => s.replace(/[^\w-]/g, "_");
    return this.page.getByTestId(`resources-worktree-row-${safe(project)}__${safe(branch)}`);
  }

  /** Locate the per-project rollup row by project name. Clicking the
   *  row toggles its expanded state and reveals the per-worktree
   *  breakdown immediately below. The test data fixture pins this
   *  to a known project. */
  getProjectRow(project: string): Locator {
    return this.page.getByTestId(`resources-project-row-${project}`);
  }

  /** Locate the per-project size cell. Starts as a "measuring…"
   *  spinner while the server's `du` walk is in flight, then
   *  resolves to the formatted byte total. The cell remains in
   *  the DOM throughout — only its contents change. */
  getProjectSize(project: string): Locator {
    return this.page.getByTestId(`resources-project-size-${project}`);
  }

  /** Click the project row's toggle button to expand it, revealing
   *  the per-worktree breakdown. The button lives in the row's
   *  first cell and bears the project name as its accessible label
   *  (a real `<button>`, not a row-level click handler, because
   *  `<button>` can't be a direct child of `<tbody>`). Idempotent in
   *  the sense that this always *opens* — call on a collapsed row. */
  async expandProject(project: string): Promise<void> {
    await test.step(`Expand project row "${project}"`, async () => {
      await this.getProjectRow(project).getByRole("button", { name: project }).click();
    });
  }

  /** Read the numeric PID currently shown in the server card. */
  async getServerPidValue(): Promise<number> {
    const text = await this.serverPid.textContent();
    return Number.parseInt((text ?? "").trim(), 10);
  }
}
