/**
 * Page object for the task view (plan step T.3) and the sidebar's projects list. The `data-testid`s
 * are set in `TaskView.tsx`, `NewTaskDialog.tsx` and `ProjectTaskList.tsx`. Test bodies call only
 * the methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class TaskPage {
  readonly root: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.root = page.getByTestId("task-view");
  }

  async goto(path = "/"): Promise<void> {
    await this.page.goto(
      `${this.baseUrl}${path}${path.includes("?") ? "&" : "?"}token=${this.token}`,
    );
  }

  // ---- sidebar --------------------------------------------------------------------------

  project(name: string): Locator {
    return this.page.locator(`[data-testid="project-tasks__project"][data-project="${name}"]`);
  }

  sidebarTask(project: string, task: string): Locator {
    return this.project(project).locator(
      `[data-testid="project-tasks__task"][data-task="${task}"]`,
    );
  }

  coordinatorRow(project: string): Locator {
    return this.project(project).getByTestId("project-tasks__coordinator");
  }

  async openFromSidebar(project: string, task: string): Promise<void> {
    await test.step(`Open task ${task} from the sidebar`, async () => {
      await this.sidebarTask(project, task).click();
      await expect(this.root).toHaveAttribute("data-task", task);
    });
  }

  // ---- new task -------------------------------------------------------------------------

  async createTask(
    project: string,
    task: { name: string; repos: string[]; brief?: string },
  ): Promise<void> {
    await test.step(`Create task ${task.name} in ${project}`, async () => {
      await this.project(project).getByTestId("project-tasks__new-task").click();
      const dialog = this.page.getByTestId("new-task");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("new-task__name").fill(task.name);
      for (const repo of task.repos) {
        await dialog.locator(`[data-testid="new-task__repo-option"][data-repo="${repo}"]`).check();
      }
      if (task.brief) await dialog.getByTestId("new-task__brief").fill(task.brief);
      await dialog.getByTestId("new-task__submit").click();
      await expect(this.root).toHaveAttribute("data-task", task.name);
    });
  }

  // ---- task view ------------------------------------------------------------------------

  members(): Locator {
    return this.root.getByTestId("task-view__member");
  }

  member(repo: string): Locator {
    return this.root.locator(`[data-testid="task-view__member"][data-repo="${repo}"]`);
  }

  chat(): Locator {
    return this.root.getByTestId("task-view__chat");
  }

  folder(): Locator {
    return this.root.getByTestId("task-view__folder");
  }

  header(): Locator {
    return this.root.getByTestId("task-view__header");
  }

  memberDiff(repo: string, file: string): Locator {
    return this.member(repo).locator(`[data-testid="task-member__diff"][data-file="${file}"]`);
  }

  async addRepo(repo: string): Promise<void> {
    await test.step(`Add repo ${repo}`, async () => {
      await this.root.getByTestId("task-view__add-repo-select").selectOption(repo);
      await this.root.getByTestId("task-view__add-repo-button").click();
    });
  }

  async removeRepo(repo: string): Promise<void> {
    await test.step(`Remove repo ${repo}`, async () => {
      await this.member(repo).getByTestId("task-member__remove").click();
    });
  }

  removeError(repo: string): Locator {
    return this.member(repo).getByTestId("task-member__error");
  }

  // ---- terminal -------------------------------------------------------------------------

  /** Opens a terminal in the task folder, or in a member's worktree. */
  async openTerminal(member?: string): Promise<Locator> {
    return await test.step(`Open a terminal in ${member ?? "the task folder"}`, async () => {
      await this.root.getByTestId("task-view__terminal-member").selectOption(member ?? "");
      await this.root.getByTestId("task-view__terminal-open").click();
      const terminal = this.root.getByTestId("task-view__terminal");
      await expect(terminal).toBeVisible();
      return terminal;
    });
  }

  /** Types a command into the terminal and returns once the screen shows `expected`. */
  async runInTerminal(terminal: Locator, command: string): Promise<void> {
    await terminal.getByRole("textbox", { name: "Terminal input" }).focus();
    await this.page.keyboard.type(`${command}\n`);
  }

  /** The text of the terminal's screen and scrollback. */
  async terminalText(terminal: Locator): Promise<string> {
    const id = await terminal.getAttribute("data-terminal-id");
    return await this.page.evaluate((terminalId) => {
      type Line = { isWrapped: boolean; translateToString(trim: boolean): string };
      type Term = { buffer: { active: { length: number; getLine(i: number): Line | undefined } } };
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const term = cache?.get(terminalId ?? "")?.getTerminal() as Term | null | undefined;
      if (!term) return "";
      // A command longer than the terminal is wrapped over several rows; join them back.
      const lines: string[] = [];
      for (let i = 0; i < term.buffer.active.length; i++) {
        const line = term.buffer.active.getLine(i);
        const text = line?.translateToString(!line.isWrapped) ?? "";
        if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
        else lines.push(text);
      }
      return lines.join("\n");
    }, id);
  }
}
