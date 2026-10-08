/**
 * Page object for a project's view, the projects list in the sidebar (`ProjectTaskList.tsx`) and
 * the New project flow (`CreateProjectFlow.tsx`). A project opens at `/project/<name>`, in the
 * worktree view of its folder (scope id `project:<id>`): the coordinator's chat and terminals in
 * the center, the folder's files in the right panel's Explorer, and the project side tabs Activity and Repos (`ProjectSideTabs.tsx`) in place of Changes. Each section lives in one of those tabs,
 * so a test switches with `showTab` before it reads it. A project's settings (title, coordinator
 * host, policy, Delete) live in Settings > Projects, which the "⋮" menu on the project's sidebar
 * row opens (`openSettings`). Test bodies call only the methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { FILE_VIEWER_ROOT_TESTID, FileViewerPage } from "./FileViewerPage";
import { TerminalSurface } from "./TerminalSurface";

export type ProjectTab = "activity" | "repos";

export interface NewProject {
  name: string;
  description?: string;
  /** Repos already registered in Band, added in the flow's repos step. */
  repos: Array<{ repo: string; role?: string }>;
}

export class ProjectsPage {
  readonly detail: Locator;
  /** One project's page in Settings > Projects (`ProjectsSettings.tsx`). */
  private readonly settings: Locator;
  private readonly sidebar: Locator;
  private readonly flow: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    // The project side tab on screen. Every tab's root carries the project's name and id.
    this.detail = page
      .getByTestId("right-sidepanel")
      .getByTestId(/^project-page__(activity|repos)$/);
    this.settings = page.getByTestId("project-settings-page");
    this.sidebar = page.getByTestId("project-tasks");
    this.flow = page.getByTestId("create-project__flow");
  }

  /** Loads the app and waits for the sidebar's projects list. */
  async goto(): Promise<void> {
    await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
    await expect(this.sidebar).toBeVisible();
  }

  /** Loads `/project/<name>`, which opens the project's folder view, on its Activity tab. */
  async gotoProject(name: string): Promise<void> {
    await test.step(`Open /project/${name}`, async () => {
      await this.page.goto(
        `${this.baseUrl}/project/${encodeURIComponent(name)}?token=${this.token}`,
      );
      await expect(this.page).toHaveURL(new RegExp(`/project/${name}(\\?|$)`));
      await this.showTab("activity");
      await expect(this.detail).toHaveAttribute("data-project", name);
    });
  }

  /** Loads `/project/<name>` on a phone, where the side tabs are sheets of the header menu. */
  async gotoProjectOnPhone(name: string): Promise<void> {
    await test.step(`Open /project/${name} on a phone`, async () => {
      await this.page.goto(
        `${this.baseUrl}/project/${encodeURIComponent(name)}?token=${this.token}`,
      );
      await expect(this.page.getByTestId("mobile-worktree__header")).toBeVisible();
    });
  }

  /** Loads an older link to a project's view: `/project/<id>` or `/worktree/project:<id>`. */
  async gotoOldLink(path: string): Promise<void> {
    await test.step(`Open the older link ${path}`, async () => {
      await this.page.goto(`${this.baseUrl}${path}?token=${this.token}`);
    });
  }

  /** Waits for the URL to name the project's view, `/project/<name>`. */
  async expectProjectUrl(name: string): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`/project/${name}(\\?|$)`));
  }

  /** Loads `/project/<name>` for a project that does not exist. */
  async gotoMissingProject(name: string): Promise<void> {
    await this.page.goto(`${this.baseUrl}/project/${encodeURIComponent(name)}?token=${this.token}`);
    await expect(this.missing()).toBeVisible();
  }

  // ---- sidebar --------------------------------------------------------------------------------

  /** A project's block in the sidebar. */
  item(name: string): Locator {
    return this.sidebar.locator(`[data-testid="project-tasks__project"][data-project="${name}"]`);
  }

  /** The projects in the sidebar, in their order. */
  items(): Locator {
    return this.sidebar.getByTestId("project-tasks__project");
  }

  itemName(name: string): Locator {
    return this.item(name).getByTestId("project-tasks__project-name");
  }

  /** A project's name button in the sidebar. `aria-current="page"` marks the project shown. */
  itemOpen(name: string): Locator {
    return this.item(name).getByTestId("project-tasks__project-open");
  }

  async toggleItem(name: string): Promise<void> {
    await this.item(name).getByTestId("project-tasks__toggle").click();
  }

  /** Opens a project's folder view from the sidebar, on its Activity tab. */
  async openProject(name: string): Promise<void> {
    await test.step(`Open project ${name} from the sidebar`, async () => {
      await this.item(name).getByTestId("project-tasks__project-open").click();
      await expect(this.page).toHaveURL(new RegExp(`/project/${name}(\\?|$)`));
      await this.showTab("activity");
      await expect(this.detail).toHaveAttribute("data-project", name);
    });
  }

  /** Opens a project worktree's own worktree view from its sidebar row. */
  async openSidebarWorktree(name: string, worktreeId: string): Promise<void> {
    await this.item(name)
      .locator(`[data-testid="project-tasks__worktree"][data-worktree="${worktreeId}"]`)
      .click();
    await expect(this.page).toHaveURL(new RegExp(`/worktree/${encodeURIComponent(worktreeId)}`));
  }

  /** Waits for a worktree's own view, after a create or a click that opens it. */
  async expectWorktreeView(worktreeId: string): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`/worktree/${encodeURIComponent(worktreeId)}`));
  }

  /** Opens New worktree from a project's sidebar row and waits for its dialog. */
  async openNewWorktree(name: string): Promise<void> {
    const row = this.item(name);
    await row.hover();
    await row.getByTestId("project-tasks__new-worktree").click();
    await expect(this.newWorktreeDialog()).toBeVisible();
  }

  newWorktreeDialog(): Locator {
    return this.page.getByTestId("new-project-worktree");
  }

  /** Fills and submits the New worktree dialog. */
  async createWorktree(input: { repo: string; branch: string; prompt?: string }): Promise<void> {
    await test.step(`Create worktree ${input.repo} on ${input.branch}`, async () => {
      const dialog = this.newWorktreeDialog();
      await dialog.getByTestId("new-project-worktree__repo").selectOption(input.repo);
      await dialog.getByTestId("new-project-worktree__branch").fill(input.branch);
      if (input.prompt) await dialog.getByTestId("new-project-worktree__prompt").fill(input.prompt);
      await dialog.getByTestId("new-project-worktree__submit").click();
      await expect(dialog).toBeHidden();
    });
  }

  /** The worktree rows under a project in the sidebar; an expanded project lists them all. */
  sidebarWorktrees(name: string): Locator {
    return this.item(name).getByTestId("project-tasks__worktree");
  }

  // ---- New project flow -----------------------------------------------------------------------

  async openCreateFlow(): Promise<void> {
    await test.step("Open New project", async () => {
      await this.page.getByTestId("projects-header__new-project").click();
      await expect(this.flow).toHaveAttribute("data-step", "name");
    });
  }

  async fillName(name: string, description?: string): Promise<void> {
    await this.flow.getByTestId("create-project__name").fill(name);
    if (description) await this.flow.getByTestId("create-project__description").fill(description);
  }

  createButton(): Locator {
    return this.flow.getByTestId("create-project__create");
  }

  /** Submits the name step. The flow moves on to the repos step. */
  async submitName(): Promise<void> {
    await this.createButton().click();
    await expect(this.flow).toHaveAttribute("data-step", "repos");
  }

  /** Adds a repo Band already has, in the repos step. */
  async addExistingRepo(repo: string, role?: string): Promise<void> {
    await test.step(`Add ${repo} to the new project`, async () => {
      // The previous call waited for its repo to show, so the count has settled.
      if ((await this.flow.getByTestId("create-project__added-repo").count()) > 0) {
        await this.flow.getByTestId("create-project__add-another").click();
      }
      await this.flow.getByTestId("project-add-repo__mode-existing").click();
      await this.flow.getByTestId("project-add-repo__existing-select").selectOption(repo);
      if (role) await this.flow.getByTestId("project-add-repo__existing-role").fill(role);
      await this.flow.getByTestId("project-add-repo__existing-submit").click();
      await expect(this.addedRepo(repo)).toBeVisible();
    });
  }

  addedRepo(repo: string): Locator {
    return this.flow.locator(`[data-testid="create-project__added-repo"][data-repo="${repo}"]`);
  }

  async reposNext(): Promise<void> {
    await this.flow.getByTestId("create-project__repos-next").click();
    await expect(this.flow).toHaveAttribute("data-step", "host");
  }

  /** Finishes the flow, which lands on the new project's folder view. */
  async finish(name: string): Promise<void> {
    await this.flow.getByTestId("create-project__finish").click();
    await expect(this.page).toHaveURL(new RegExp(`/project/${name}(\\?|$)`));
    await this.showTab("activity");
    await expect(this.detail).toHaveAttribute("data-project", name);
  }

  /** The whole New project flow for repos Band already has. */
  async create(project: NewProject): Promise<void> {
    await test.step(`Create project ${project.name}`, async () => {
      await this.openCreateFlow();
      await this.fillName(project.name, project.description);
      await this.submitName();
      for (const { repo, role } of project.repos) await this.addExistingRepo(repo, role);
      await this.reposNext();
      await this.finish(project.name);
    });
  }

  // ---- project view -------------------------------------------------------------------------

  /** A side tab button of the project view, by id. A name that is not a tab matches nothing. */
  tab(id: string): Locator {
    return this.page.getByTestId(`right-sidepanel__tab--project-${id}`);
  }

  /** The right panel's Changes tab, which a project's folder view does not have. */
  changesTab(): Locator {
    return this.page.getByTestId("right-sidepanel__tab--changes");
  }

  async showTab(tab: ProjectTab): Promise<void> {
    const button = this.tab(tab);
    await button.click();
    await expect(button).toHaveAttribute("aria-selected", "true");
    await expect(this.page.getByTestId(`project-page__${tab}`)).toBeVisible();
  }

  /** Shows the right panel's Explorer, which lists the project folder's files. */
  async showExplorer(): Promise<void> {
    const button = this.page.getByTestId("right-sidepanel__tab--explorer");
    await button.click();
    await expect(button).toHaveAttribute("aria-selected", "true");
  }

  /** A file or folder row of the Explorer tree, by its path in the project folder. */
  explorerEntry(path: string): Locator {
    return this.page.getByTestId(`file-tree__row--${path}`);
  }

  missing(): Locator {
    return this.page.getByTestId("project-route__missing");
  }

  /** The terminal of the project's folder view (`project:<id>`), shown in its center. */
  terminal(projectId: string): TerminalSurface {
    return new TerminalSurface(this.page, `project:${projectId}`);
  }

  /** Opens a file of the project folder from the Explorer and returns its editor. */
  async openFile(path: string): Promise<FileViewerPage> {
    await test.step(`Open ${path} from the Explorer`, async () => {
      await this.showExplorer();
      await this.explorerEntry(path).click();
      await expect(this.page.getByTestId(FILE_VIEWER_ROOT_TESTID)).toBeVisible();
    });
    return new FileViewerPage(this.page);
  }

  error(): Locator {
    return this.detail.getByTestId("projects__error").first();
  }

  /** The coordinator's chat pane, a tab of the project view's center. */
  chat(): Locator {
    return this.page.getByTestId("prompt-input__form").filter({ visible: true });
  }

  /** The coordinator's agent, model and host line on the Activity tab. */
  async coordinatorMeta(): Promise<Locator> {
    await this.showTab("activity");
    return this.detail.getByTestId("project-page__coordinator-meta");
  }

  /** The Activity tab's button that opens the project folder's AGENTS.md. */
  async instructionsButton(): Promise<Locator> {
    await this.showTab("activity");
    return this.detail.getByTestId("project-page__instructions-open");
  }

  /** The project's description on the Activity tab. */
  description(): Locator {
    return this.detail.getByTestId("project-page__description");
  }

  /** A worktree of the project, as its card under the project in the sidebar. */
  worktree(id: string): Locator {
    return this.sidebar.locator(`[data-testid="project-tasks__worktree"][data-worktree="${id}"]`);
  }

  // Repos tab

  repo(name: string): Locator {
    return this.detail.locator(`[data-testid="projects__repo"][data-repo="${name}"]`);
  }

  repos(): Locator {
    return this.detail.getByTestId("projects__repo");
  }

  async removeRepo(name: string): Promise<void> {
    await this.detail.locator(`[data-testid="projects__repo-remove"][data-repo="${name}"]`).click();
  }

  /** The project folder section: the coordinator host's checkouts of each repo's default branch. */
  folder(): Locator {
    return this.detail.getByTestId("projects__folder");
  }

  checkout(repo: string): Locator {
    return this.folder().locator(`[data-testid="projects__checkout"][data-repo="${repo}"]`);
  }

  // Activity tab

  /** The coordinator section. Its `data-state` is `started` once the chat exists. */
  coordinator(): Locator {
    return this.detail.getByTestId("projects__coordinator");
  }

  /** The coordinator chat's id, which stands in for a worktree name: the coordinator has none. */
  coordinatorChat(): Locator {
    return this.detail.getByTestId("projects__coordinator-chat");
  }

  /** The subscriptions that wake the coordinator. */
  subscriptions(): Locator {
    return this.detail.getByTestId("projects__subscription");
  }

  /** The recent wake-ups. */
  wakeups(): Locator {
    return this.detail.getByTestId("projects__wakeup");
  }

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

  spend(part: "today" | "week" | "total" | "remaining" | "unattributed"): Locator {
    return this.detail.getByTestId(`dashboard__spend-${part}`);
  }

  // The project's page in Settings, opened from its sidebar menu

  /** Opens the shown project's settings from the "⋮" menu of its sidebar row. */
  async openSettings(): Promise<void> {
    await test.step("Open the project's settings", async () => {
      const name = (await this.detail.getAttribute("data-project")) ?? "";
      const row = this.item(name);
      await row.hover();
      await row.getByTestId("project-tasks__menu").click();
      await this.page.getByTestId("project-tasks__menu-settings").click();
      await expect(this.settings).toHaveAttribute("data-project", name);
    });
  }

  async closeSettings(): Promise<void> {
    await test.step("Close Settings", async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.settings).toBeHidden();
    });
  }

  async rename(title: string): Promise<void> {
    await test.step(`Rename the project to ${title}`, async () => {
      await this.settings.getByTestId("project-settings__title").fill(title);
      const saved = this.page.waitForResponse(
        (res) => res.url().includes("projects.update") && res.ok(),
      );
      await this.settings.getByTestId("project-settings__save").click();
      await saved;
    });
  }

  async deleteProject(): Promise<void> {
    await test.step("Delete the project", async () => {
      await this.settings.getByTestId("projects__remove").click();
      await this.settings.getByTestId("projects__remove-confirm").click();
    });
  }

  /** The select for one model lane: coordinator, worker or reviewer. */
  lane(lane: "coordinator" | "worker" | "reviewer"): Locator {
    return lane === "coordinator"
      ? this.settings.getByTestId("projects__model-select")
      : this.settings.getByTestId(`projects__lane-${lane}`);
  }

  autonomy(): Locator {
    return this.settings.getByTestId("projects__autonomy");
  }

  async chooseAutonomy(level: "observe" | "autonomous"): Promise<void> {
    await test.step(`Set autonomy to ${level}`, async () => {
      // The page saves everything with one Save; `savePolicy` sends it.
      await this.autonomy().selectOption(level);
      await expect(this.autonomy()).toHaveValue(level);
    });
  }

  maxConcurrent(): Locator {
    return this.settings.getByTestId("projects__max-concurrent");
  }

  budget(): Locator {
    return this.settings.getByTestId("projects__budget");
  }

  isolationFloor(): Locator {
    return this.settings.getByTestId("projects__isolation-floor");
  }

  async savePolicy(limits: {
    maxConcurrent?: string;
    budget?: string;
    isolationFloor?: "worktree" | "container" | "vm";
    workerModel?: string;
    coordinatorModel?: string;
  }): Promise<void> {
    await test.step("Save the policy", async () => {
      if (limits.maxConcurrent !== undefined) await this.maxConcurrent().fill(limits.maxConcurrent);
      if (limits.budget !== undefined) await this.budget().fill(limits.budget);
      if (limits.isolationFloor) await this.isolationFloor().selectOption(limits.isolationFloor);
      if (limits.workerModel) await this.lane("worker").selectOption(limits.workerModel);
      if (limits.coordinatorModel) {
        await this.lane("coordinator").selectOption(limits.coordinatorModel);
      }
      // The page gives no other sign that the save finished.
      const saved = this.page.waitForResponse(
        (res) => res.url().includes("projects.update") && res.ok(),
      );
      await this.settings.getByTestId("project-settings__save").click();
      await saved;
    });
  }
}
