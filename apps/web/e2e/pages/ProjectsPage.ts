/**
 * Page object for the Projects dialog (plan step 6.1), opened from the Projects button in the
 * sidebar's bottom action bar. `data-testid`s are set in `ProjectsDialog.tsx` and
 * `DashboardShell.tsx`. Test bodies call only the methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { ContextBrowserPage } from "./ContextBrowserPage";

export interface NewProject {
  name: string;
  description?: string;
  repos: Array<{ repo: string; role?: string }>;
}

export class ProjectsPage {
  private readonly dialog: Locator;
  private readonly detail: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByTestId("projects");
    this.detail = page.getByTestId("projects__detail");
  }

  emptyState(): Locator {
    return this.dialog.getByTestId("projects__empty");
  }

  async goto(): Promise<void> {
    await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
    await expect(this.page.getByTestId("repo-list__projects-button")).toBeVisible();
  }

  async open(): Promise<void> {
    await test.step("Open the Projects dialog", async () => {
      await this.page.getByTestId("repo-list__projects-button").click();
      await expect(this.dialog).toBeVisible();
    });
  }

  item(name: string): Locator {
    return this.dialog.locator(`[data-testid="projects__item"][data-project="${name}"]`);
  }

  async create(project: NewProject): Promise<void> {
    await test.step(`Create project ${project.name}`, async () => {
      await this.dialog.getByTestId("projects__new").click();
      const form = this.page.getByTestId("projects__create");
      await form.getByTestId("projects__name").fill(project.name);
      if (project.description) {
        await form.getByTestId("projects__description").fill(project.description);
      }
      for (const { repo, role } of project.repos) {
        await form.locator(`[data-testid="projects__repo-option"][data-repo="${repo}"]`).check();
        if (role) {
          await form.locator(`[data-testid="projects__repo-role"][data-repo="${repo}"]`).fill(role);
        }
      }
      await form.getByTestId("projects__create-submit").click();
      await expect(this.detail).toBeVisible();
    });
  }

  async back(): Promise<void> {
    await this.detail.getByTestId("projects__back").click();
    await expect(this.dialog.getByTestId("projects__list")).toBeVisible();
  }

  async openProject(name: string): Promise<void> {
    await this.item(name).click();
    await expect(this.detail).toHaveAttribute("data-project", name);
  }

  repo(name: string): Locator {
    return this.detail.locator(`[data-testid="projects__repo"][data-repo="${name}"]`);
  }

  repos(): Locator {
    return this.detail.getByTestId("projects__repo");
  }

  async removeRepo(name: string): Promise<void> {
    await this.detail.locator(`[data-testid="projects__repo-remove"][data-repo="${name}"]`).click();
  }

  worktreeGroup(repo: string): Locator {
    return this.detail.locator(`[data-testid="projects__worktree-group"][data-repo="${repo}"]`);
  }

  error(): Locator {
    return this.detail.getByTestId("projects__error");
  }

  modelSelect(): Locator {
    return this.detail.getByTestId("projects__model-select");
  }

  async chooseModel(model: string): Promise<void> {
    await this.modelSelect().selectOption(model);
  }

  async openContext(): Promise<ContextBrowserPage> {
    await this.detail.getByTestId("projects__context-link").click();
    const browser = new ContextBrowserPage(this.page, this.baseUrl, this.token);
    await expect(browser.root).toBeVisible();
    return browser;
  }

  /** The coordinator section of the open project. Its `data-state` is `started` once the chat exists. */
  coordinator(): Locator {
    return this.detail.getByTestId("projects__coordinator");
  }

  coordinatorWorktree(): Locator {
    return this.detail.getByTestId("projects__coordinator-worktree");
  }

  autonomy(): Locator {
    return this.detail.getByTestId("projects__autonomy");
  }

  async chooseAutonomy(level: "observe" | "steer" | "autonomous"): Promise<void> {
    await test.step(`Set autonomy to ${level}`, async () => {
      await this.autonomy().selectOption(level);
      await expect(this.detail.getByTestId("projects__policy")).toHaveAttribute(
        "data-autonomy",
        level,
      );
    });
  }

  /** The select for one model lane: coordinator, worker or reviewer. */
  lane(lane: "coordinator" | "worker" | "reviewer"): Locator {
    return lane === "coordinator"
      ? this.detail.getByTestId("projects__model-select")
      : this.detail.getByTestId(`projects__lane-${lane}`);
  }

  maxConcurrent(): Locator {
    return this.detail.getByTestId("projects__max-concurrent");
  }

  budget(): Locator {
    return this.detail.getByTestId("projects__budget");
  }

  isolationFloor(): Locator {
    return this.detail.getByTestId("projects__isolation-floor");
  }

  async savePolicy(limits: {
    maxConcurrent?: string;
    budget?: string;
    isolationFloor?: "worktree" | "container" | "vm";
    workerModel?: string;
  }): Promise<void> {
    await test.step("Save the policy", async () => {
      if (limits.maxConcurrent !== undefined) await this.maxConcurrent().fill(limits.maxConcurrent);
      if (limits.budget !== undefined) await this.budget().fill(limits.budget);
      if (limits.isolationFloor) await this.isolationFloor().selectOption(limits.isolationFloor);
      if (limits.workerModel) await this.lane("worker").selectOption(limits.workerModel);
      // The dialog gives no other sign that the save finished.
      const saved = this.page.waitForResponse(
        (res) => res.url().includes("projects.update") && res.ok(),
      );
      await this.detail.getByTestId("projects__policy-save").click();
      await saved;
    });
  }

  /** The pending or failed dispatch request cards of the open project. */
  dispatches(): Locator {
    return this.detail.getByTestId("projects__dispatch");
  }

  async approveDispatch(): Promise<void> {
    await test.step("Approve the dispatch", async () => {
      await this.detail.getByTestId("projects__dispatch-approve").click();
    });
  }

  async rejectDispatch(): Promise<void> {
    await test.step("Reject the dispatch", async () => {
      await this.detail.getByTestId("projects__dispatch-reject").click();
    });
  }

  noDispatches(): Locator {
    return this.detail.getByTestId("projects__no-dispatches");
  }

  worktree(id: string): Locator {
    return this.detail.locator(`[data-testid="projects__worktree"][data-worktree="${id}"]`);
  }

  group(branch: string): Locator {
    return this.detail.locator(`[data-testid="projects__group"][data-branch="${branch}"]`);
  }

  groupMembers(branch: string): Locator {
    return this.group(branch).getByTestId("projects__group-member");
  }

  /** The subscriptions that wake the open project's coordinator. */
  subscriptions(): Locator {
    return this.detail.getByTestId("projects__subscription");
  }

  /** The recent wake-ups the open project page lists. */
  wakeups(): Locator {
    return this.detail.getByTestId("projects__wakeup");
  }

  // ---- dashboard (step 6.6) ---------------------------------------------------------------

  /** The agents the dashboard lists, the coordinator first. */
  dashboardAgents(): Locator {
    return this.detail.getByTestId("dashboard__agent");
  }

  dashboardAgent(role: "coordinator" | "worker"): Locator {
    return this.detail.locator(`[data-testid="dashboard__agent"][data-role="${role}"]`);
  }

  async stopAgent(role: "coordinator" | "worker"): Promise<void> {
    await test.step(`Stop the ${role}`, async () => {
      await this.dashboardAgent(role).first().getByTestId("dashboard__agent-stop").click();
    });
  }

  dashboardMembers(): Locator {
    return this.detail.getByTestId("dashboard__member");
  }

  dashboardMember(repo: string): Locator {
    return this.detail.locator(`[data-testid="dashboard__member"][data-repo="${repo}"]`);
  }

  dashboardApprovals(): Locator {
    return this.detail.getByTestId("dashboard__approval");
  }

  async approveFromDashboard(): Promise<void> {
    await test.step("Approve the dispatch from the dashboard", async () => {
      await this.detail.getByTestId("dashboard__approval-approve").first().click();
    });
  }

  spend(part: "today" | "week" | "total" | "remaining" | "unattributed"): Locator {
    return this.detail.getByTestId(`dashboard__spend-${part}`);
  }
}
