/**
 * Page object for the Tasks dialog.
 *
 * Same shape as `ReportsDialog` — no dedicated route; the dialog is opened
 * from the 3-dot overflow menu in the repo-list bottom action bar. Owns
 * the locators for the filter controls, task cards, status badges, the
 * empty state, and the nested New Task dialog.
 *
 * Locator priority:
 *
 *   - `getByRole({ name })` for the Tasks / New Task dialogs and the overflow
 *     menu item (system-controlled ARIA names).
 *   - `getByTestId(...)` (BEM `tasks__*`, set in `TasksPageContent.tsx`) for
 *     every owned control — filters, per-task cards (`tasks__card--<id>`),
 *     status badges (`tasks__status-badge--<status>`), empty state, and the
 *     New Task form fields. This keeps assertions off localisable copy.
 *   - `getByRole("option", { name })` for Radix select options, whose name is
 *     the option value (repo name / status enum), not free product copy.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export type TaskStatus = "running" | "completed" | "failed";

export class TasksDialog {
  /** The Tasks dialog body. */
  readonly dialog: Locator;
  /** 3-dot overflow trigger in the repo-list bottom action bar. */
  readonly overflowTrigger: Locator;
  /** "Tasks" entry inside the overflow dropdown. */
  readonly tasksMenuItem: Locator;
  /** Repo filter select trigger. */
  readonly repoFilter: Locator;
  /** Status filter select trigger. */
  readonly statusFilter: Locator;
  /** Empty-state container (shown when no task matches the filters). */
  readonly emptyState: Locator;
  /** "New Task" button in the Tasks toolbar (desktop variant). */
  readonly newTaskButton: Locator;
  /** The nested New Task dialog body. */
  readonly newTaskDialog: Locator;
  /** Repo / Worktree / Prompt controls inside the New Task dialog. */
  readonly newTaskRepo: Locator;
  readonly newTaskWorktree: Locator;
  readonly newTaskPrompt: Locator;
  /** Session deep-link on a completed task card. */
  readonly sessionLink: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByRole("dialog", { name: "Tasks" });
    this.overflowTrigger = page.getByTestId("repo-list__overflow-trigger");
    this.tasksMenuItem = page.getByRole("menuitem", { name: "Tasks" });
    this.repoFilter = page.getByTestId("tasks__repo-filter");
    this.statusFilter = page.getByTestId("tasks__status-filter");
    this.emptyState = page.getByTestId("tasks__empty-state");
    this.newTaskButton = page.getByTestId("tasks__new-task-button");
    this.newTaskDialog = page.getByTestId("tasks__new-task-dialog");
    this.newTaskRepo = page.getByTestId("tasks__new-task-repo");
    this.newTaskWorktree = page.getByTestId("tasks__new-task-worktree");
    this.newTaskPrompt = page.getByTestId("tasks__new-task-prompt");
    this.sessionLink = this.dialog.getByTestId("tasks__session-link");
  }

  /** Navigate to the dashboard root with the test token. */
  async goto(): Promise<void> {
    await test.step("Open dashboard", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      // The dashboard fetches repos via tRPC on mount, so the action bar's
      // click handlers may not be bound by the time `load` fires. Wait for the
      // network to settle before driving the overflow dropdown.
      await this.page.waitForLoadState("networkidle");
    });
  }

  /** Open the overflow menu and click Tasks. Re-clicks the trigger until the
   *  menu actually appears (covers the hydration race where a fast first click
   *  is lost before React binds the dropdown's onClick). */
  async open(): Promise<void> {
    await test.step("Open Tasks via the bottom action bar overflow", async () => {
      await expect(this.overflowTrigger).toBeVisible();
      await expect(async () => {
        await this.overflowTrigger.click();
        await expect(this.tasksMenuItem).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await this.tasksMenuItem.click();
      await expect(this.dialog).toBeVisible();
    });
  }

  /** Task card for a seeded task id. */
  card(taskId: string): Locator {
    return this.dialog.getByTestId(`tasks__card--${taskId}`);
  }

  /** Status badge (any card) for a given status. */
  statusBadge(status: TaskStatus): Locator {
    return this.dialog.getByTestId(`tasks__status-badge--${status}`);
  }

  /** Pick a repo from the repo filter. Pass a repo name, or
   *  "All Repos" to clear it. */
  async filterByRepo(optionName: string): Promise<void> {
    await test.step(`Filter tasks by repo "${optionName}"`, async () => {
      await this.repoFilter.click();
      await this.page.getByRole("option", { name: optionName }).click();
    });
  }

  /** Pick a status from the status filter (e.g. "completed"). */
  async filterByStatus(optionName: string): Promise<void> {
    await test.step(`Filter tasks by status "${optionName}"`, async () => {
      await this.statusFilter.click();
      await this.page.getByRole("option", { name: optionName }).click();
    });
  }

  /** Open the nested New Task dialog. */
  async openNewTask(): Promise<void> {
    await test.step("Open the New Task dialog", async () => {
      await this.newTaskButton.click();
      await expect(this.newTaskDialog).toBeVisible();
    });
  }
}
