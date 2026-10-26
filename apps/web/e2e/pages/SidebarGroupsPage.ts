/**
 * Page object for the sidebar's Groups view: the group headers, the worktree rows under each, the
 * "from <parent>" chip, dragging a card onto a header and the dialogs a header opens. Locators use
 * the test ids set in `GroupedWorktrees.tsx` and `GroupDialogs.tsx`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { SidebarPinsDragPage } from "./SidebarPinsDragPage";

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

  /** The whole list: Pinned, the groups and the rows with no group. */
  get root(): Locator {
    return this.groupsPage.getByTestId("repo-list__root");
  }

  /** The strip below the last group that takes a drop to the top level, drawn while no row is ungrouped. */
  get topLevelDrop(): Locator {
    return this.groupsPage.getByTestId("repo-list__top-level-drop");
  }

  groupName(groupId: string): Locator {
    return this.groupsPage.getByTestId(`repo-list__group-name--${groupId}`);
  }

  /** The agent status dot at the start of a worktree's card, in the list or in Pinned. */
  statusDot(row: Locator): Locator {
    return row.getByTestId("worktree-card__agent-status").first();
  }

  /** The chevron icon inside a row's expand/collapse button. */
  originToggleIcon(worktreeId: string): Locator {
    return this.groupsPage.getByTestId(`repo-list__origin-toggle-icon--${worktreeId}`);
  }

  /** The computed background color of a row's expand/collapse button. */
  originToggleBackground(worktreeId: string): Promise<string> {
    return this.originToggle(worktreeId).evaluate((el) => getComputedStyle(el).backgroundColor);
  }

  /** The box of an element, failing the test when it is not laid out. */
  async box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await locator.boundingBox();
    expect(box, "element is laid out").not.toBeNull();
    return box!;
  }

  /** The "from <parent>" chip of a row. */
  fromParentChip(worktreeId: string): Locator {
    return this.groupsPage.getByTestId(`repo-list__from-parent--${worktreeId}`);
  }

  /**
   * The worktree ids under each group header, in display order, keyed by group id (`UNGROUPED`
   * for the plain rows of worktrees in no group) with the depth of each row. Read from the document
   * order of headers and rows. The plain rows come after the last group, so a row counts as
   * Ungrouped by its `data-ungrouped` mark, and `sections` throws if a group header follows one.
   */
  async sections(): Promise<Record<string, string[]>> {
    return this.groupsPage
      .locator(
        '[data-testid^="repo-list__group-header--"], [data-testid^="repo-list__grouped-row--"]',
      )
      .evaluateAll((found) => {
        // Playwright can resolve the list before a React commit and run this after it, so the
        // array may hold the old order. Sort by the live document order.
        const els = [...found].sort((a, b) =>
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        );
        const result: Record<string, string[]> = { __ungrouped: [] };
        let current = "";
        let seenUngrouped = false;
        for (const el of els) {
          const id = el.getAttribute("data-testid") ?? "";
          if (id.startsWith("repo-list__group-header--")) {
            if (seenUngrouped) throw new Error(`${id} comes after a row with no group`);
            current = id.replace("repo-list__group-header--", "");
            result[current] = [];
            continue;
          }
          const ungrouped = el.hasAttribute("data-ungrouped");
          seenUngrouped ||= ungrouped;
          const key = ungrouped ? "__ungrouped" : current;
          if (!key) throw new Error(`${id} has no group header above it`);
          result[key].push(
            `${el.getAttribute("data-depth")}:${id.replace("repo-list__grouped-row--", "")}`,
          );
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

  /** Drags a worktree's row onto another worktree's row (middle), or beside it (top or bottom). */
  async dragToWorktree(
    worktreeId: string,
    targetId: string,
    position: "top" | "middle" | "bottom" = "middle",
  ): Promise<void> {
    await test.step(`Drag ${worktreeId} onto ${targetId} (${position})`, async () => {
      await this.drag(this.row(worktreeId), this.row(targetId), position);
    });
  }

  /** The old group-by trigger, which no longer exists. */
  get groupByTrigger(): Locator {
    return this.groupsPage.getByTestId("repos-panel__group-by");
  }

  /** "New group…" in the open group filter menu. */
  get newGroupMenuItem(): Locator {
    return this.groupsPage.getByTestId("dashboard__group-filter-new-group");
  }

  /** The worktree card inside the drag preview. */
  previewCard(worktreeId: string): Locator {
    return this.dragPreview.getByTestId(`repo-list__worktree-card--${worktreeId}`);
  }

  /** The worktree card inside a list row. */
  rowCard(worktreeId: string): Locator {
    return this.row(worktreeId).getByTestId(`repo-list__worktree-card--${worktreeId}`);
  }

  /** The card the drag preview shows, or nothing while no drag is on. */
  get dragPreview(): Locator {
    return this.groupsPage.getByTestId("repo-list__drag-overlay");
  }

  /** Picks a row up and moves over `target` without letting go, so the preview and highlight show. */
  async holdDrag(source: Locator, target: Locator): Promise<void> {
    await test.step("Pick a row up and hold it over another", async () => {
      const from = await source.boundingBox();
      const to = await target.boundingBox();
      expect(from).not.toBeNull();
      expect(to).not.toBeNull();
      const startX = from!.x + Math.min(40, from!.width / 2);
      const startY = from!.y + from!.height / 2;
      await this.groupsPage.mouse.move(startX, startY);
      await this.groupsPage.mouse.down();
      await this.groupsPage.mouse.move(startX + 12, startY + 12, { steps: 4 });
      await this.groupsPage.mouse.move(
        to!.x + Math.min(40, to!.width / 2),
        to!.y + to!.height / 2,
        {
          steps: 12,
        },
      );
    });
  }

  async dropHeld(): Promise<void> {
    await this.groupsPage.mouse.up();
  }

  /** The draggable wrapper of a row, which carries the drop highlight in `data-drop-zone`. */
  dropTarget(worktreeId: string): Locator {
    return this.groupsPage.getByTestId(`repo-list__drag-row--${worktreeId}`);
  }

  async dismissRefusal(): Promise<void> {
    await this.dropRefusal.getByRole("button", { name: "Dismiss" }).click();
  }

  /** The depth of a row under its group header. */
  async depthOf(worktreeId: string): Promise<number> {
    return Number(await this.row(worktreeId).getAttribute("data-depth"));
  }

  /**
   * Drags a worktree's row to the top level, where it is in no group. The target is the top-level
   * strip below the last group, or the top of `besideRow` when plain rows exist and the strip is not
   * drawn.
   */
  async dragToTopLevel(worktreeId: string, besideRow?: string): Promise<void> {
    await test.step(`Drag ${worktreeId} to the top level`, async () => {
      if (besideRow) {
        await this.drag(this.row(worktreeId), this.row(besideRow), "top");
        return;
      }
      await this.drag(this.row(worktreeId), this.topLevelDrop, "middle");
    });
  }

  /** Drags a group's header above or below another group's header. */
  async dragGroup(groupId: string, targetId: string, position: "top" | "bottom"): Promise<void> {
    await test.step(`Drag the group ${groupId} ${position === "top" ? "above" : "below"} ${targetId}`, async () => {
      await this.drag(this.groupHeader(groupId), this.groupHeader(targetId), position);
    });
  }

  /** Picks Move up or Move down in a group header's menu. */
  async moveGroupFromMenu(groupId: string, direction: "up" | "down"): Promise<void> {
    await test.step(`Move the group ${groupId} ${direction} from its menu`, async () => {
      await this.openGroupMenu(groupId);
      await this.groupsPage.getByTestId(`repo-list__group-action--move-${direction}`).click();
    });
  }

  moveMenuItem(direction: "up" | "down"): Locator {
    return this.groupsPage.getByTestId(`repo-list__group-action--move-${direction}`);
  }

  get toggleAllButton(): Locator {
    return this.groupsPage.getByTestId("repos-panel__toggle-all");
  }

  /** The aria label the toggle-all button shows: "Collapse all" or "Expand all". */
  async toggleAllLabel(): Promise<string | null> {
    return this.toggleAllButton.getAttribute("aria-label");
  }

  /** Clicks the collapse-all / expand-all button once. */
  async clickToggleAll(): Promise<void> {
    await test.step("Click the collapse-all / expand-all button", async () => {
      await this.toggleAllButton.click();
    });
  }

  /** The left edge of the Pinned header, a group header or an ungrouped row. */
  async leftEdge(locator: Locator): Promise<number> {
    return (await locator.boundingBox())?.x ?? Number.NaN;
  }

  get pinnedHeaderLocator(): Locator {
    return this.pinnedHeader;
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

  /** Makes a group from the group filter's "New group…" item. */
  async createGroup(name: string): Promise<void> {
    await test.step(`Create the group ${name} from the group filter`, async () => {
      await this.groupsPage.getByTestId("dashboard__group-filter-trigger").click();
      await this.groupsPage.getByTestId("dashboard__group-filter-new-group").click();
      await this.groupsPage.getByTestId("group-dialog__name").fill(name);
      await this.groupsPage.getByTestId("group-dialog__submit").click();
      await expect(this.groupsPage.getByTestId("group-dialog")).toBeHidden();
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
