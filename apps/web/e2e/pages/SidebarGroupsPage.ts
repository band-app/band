/**
 * Page object for the sidebar's Groups view: the group headers, the worktree rows under each, the
 * "from <parent>" chip, dragging a card onto a header and the dialogs a header opens. Locators use
 * the test ids set in `GroupedWorktrees.tsx` and `GroupDialogs.tsx`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { SidebarPinsDragPage } from "./SidebarPinsDragPage";
import type { WorktreePage } from "./WorktreePage";

/** The key of the Ungrouped section in test ids. */
export const UNGROUPED = "__ungrouped";

export class SidebarGroupsPage extends SidebarPinsDragPage {
  constructor(private readonly groupsPage: Page) {
    super(groupsPage);
  }

  /** The header of a group, or of Ungrouped with `UNGROUPED`. */
  groupHeader(groupId: string): Locator {
    return this.groupsPage.getByTestId(`repo-list__group-header--${groupId}`);
  }

  groupCount(groupId: string): Locator {
    return this.groupsPage.getByTestId(`repo-list__group-count--${groupId}`);
  }

  groupDot(groupId: string): Locator {
    return this.groupsPage.getByTestId(`repo-list__group-dot--${groupId}`);
  }

  /** The "from <parent>" chip of a row. */
  fromParentChip(worktreeId: string): Locator {
    return this.groupsPage.getByTestId(`repo-list__from-parent--${worktreeId}`);
  }

  /**
   * The worktree ids under each group header, in display order, keyed by group id (`UNGROUPED`
   * for Ungrouped) with the depth of each row. Read from the document order of headers and rows.
   */
  async sections(): Promise<Record<string, string[]>> {
    return this.groupsPage
      .locator(
        '[data-testid^="repo-list__group-header--"], [data-testid^="repo-list__grouped-row--"]',
      )
      .evaluateAll((els) => {
        const result: Record<string, string[]> = {};
        let current = "";
        for (const el of els) {
          const id = el.getAttribute("data-testid") ?? "";
          if (id.startsWith("repo-list__group-header--")) {
            current = id.replace("repo-list__group-header--", "");
            result[current] = [];
          } else if (current) {
            result[current].push(
              `${el.getAttribute("data-depth")}:${id.replace("repo-list__grouped-row--", "")}`,
            );
          }
        }
        return result;
      });
  }

  /** The group ids in header order. */
  async headerOrder(): Promise<string[]> {
    return this.groupsPage
      .locator('[data-testid^="repo-list__group-header--"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""))
      .then((ids) => ids.map((id) => id.replace("repo-list__group-header--", "")));
  }

  /** Drags a worktree's row onto a group's header. */
  async dragToGroup(worktreeId: string, groupId: string): Promise<void> {
    await test.step(`Drag ${worktreeId} onto the group ${groupId}`, async () => {
      await this.drag(this.row(worktreeId), this.groupHeader(groupId), "middle");
    });
  }

  get moveChildrenDialog(): Locator {
    return this.groupsPage.getByTestId("group-move-dialog");
  }

  /** Answers "Move its N children too?" with the default, moving them. */
  async moveWithChildren(): Promise<void> {
    await test.step("Move the worktree with its children", async () => {
      await expect(this.moveChildrenDialog).toBeVisible();
      await this.groupsPage.getByTestId("group-move-dialog__with-children").click();
      await expect(this.moveChildrenDialog).toBeHidden();
    });
  }

  /** Answers "Move its N children too?" with only the dragged worktree. */
  async moveOnly(): Promise<void> {
    await test.step("Move only the dragged worktree", async () => {
      await expect(this.moveChildrenDialog).toBeVisible();
      await this.groupsPage.getByTestId("group-move-dialog__only").click();
      await expect(this.moveChildrenDialog).toBeHidden();
    });
  }

  /** The default button of the children dialog has keyboard focus. */
  get moveWithChildrenButton(): Locator {
    return this.groupsPage.getByTestId("group-move-dialog__with-children");
  }

  /** Opens a group header's context menu. */
  async openGroupMenu(groupId: string): Promise<void> {
    await this.groupHeader(groupId).click({ button: "right" });
  }

  /** Renames a group from its header menu. */
  async renameFromMenu(groupId: string, name: string): Promise<void> {
    await test.step(`Rename ${groupId} to ${name} from its header menu`, async () => {
      await this.openGroupMenu(groupId);
      await this.groupsPage.getByTestId("repo-list__group-action--rename").click();
      await this.groupsPage.getByTestId("group-dialog__name").fill(name);
      await this.groupsPage.getByTestId("group-dialog__submit").click();
      await expect(this.groupsPage.getByTestId("group-dialog")).toBeHidden();
    });
  }

  /** Picks a preset color of a group from its header menu, by lowercase name. */
  async recolorFromMenu(groupId: string, preset: string): Promise<void> {
    await test.step(`Recolor ${groupId} to ${preset} from its header menu`, async () => {
      await this.openGroupMenu(groupId);
      await this.groupsPage.getByTestId("repo-list__group-action--color").click();
      await this.groupsPage.getByTestId(`repo-list__group-color--${preset}`).click();
    });
  }

  /** Deletes a group from its header menu and confirms. */
  async deleteFromMenu(groupId: string): Promise<void> {
    await test.step(`Delete ${groupId} from its header menu`, async () => {
      await this.openGroupMenu(groupId);
      await this.groupsPage.getByTestId("repo-list__group-action--delete").click();
      await this.groupsPage.getByTestId("group-delete-dialog__confirm").click();
    });
  }

  /** Makes a group from the Group by menu. */
  async createGroup(name: string): Promise<void> {
    await test.step(`Create the group ${name} from the Group by menu`, async () => {
      await this.groupByTrigger.click();
      await this.groupsPage.getByTestId("repos-panel__new-group").click();
      await this.groupsPage.getByTestId("group-dialog__name").fill(name);
      await this.groupsPage.getByTestId("group-dialog__submit").click();
      await expect(this.groupsPage.getByTestId("group-dialog")).toBeHidden();
    });
  }

  /** Creates a worktree from a repo's menu in the Repo view: Add worktree, then the branch name. */
  async addWorktreeFromRepoMenu(worktreePage: WorktreePage, repo: string, branch: string) {
    await test.step(`Create ${branch} in ${repo} from the repo menu`, async () => {
      await worktreePage.openRepoContextMenu(repo);
      await worktreePage.addWorktreeMenuItem.click();
      await this.groupsPage.getByTestId("new-worktree-form__branch").fill(branch);
      await this.groupsPage.getByTestId("new-worktree-form__submit").click();
    });
  }

  /** Starts a worktree from a group header's "+": picks the repo and names the branch. */
  async addWorktreeInGroup(groupId: string, repo: string, branch: string): Promise<void> {
    await test.step(`Create ${branch} in ${repo} from the group ${groupId}`, async () => {
      await this.groupsPage.getByTestId(`repo-list__group-add--${groupId}`).click();
      await this.groupsPage.getByTestId(`group-pick-repo__item--${repo}`).click();
      await this.groupsPage.getByTestId("new-worktree-form__branch").fill(branch);
      await this.groupsPage.getByTestId("new-worktree-form__submit").click();
    });
  }
}
