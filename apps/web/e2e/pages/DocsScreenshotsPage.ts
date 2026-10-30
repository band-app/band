/**
 * Page object for the docs screenshot spec (`docs-screenshots.spec.ts`). It drives the real UI
 * to each state the public docs show, and saves a PNG into the website's public folder.
 * Test bodies call only the methods here.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { AddRepoPage } from "./AddRepoPage";
import { ChatPanePage } from "./ChatPanePage";
import { SettingsPage } from "./SettingsPage";
import { WorktreePage } from "./WorktreePage";

export const SCREENSHOT_DIR = join(import.meta.dirname, "../../../website/public/docs/screenshots");

export class DocsScreenshotsPage {
  readonly worktree: WorktreePage;
  readonly chat: ChatPanePage;
  readonly settings: SettingsPage;
  readonly addRepo: AddRepoPage;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.worktree = new WorktreePage(page, baseUrl, token);
    this.chat = new ChatPanePage(page, baseUrl, token);
    this.settings = new SettingsPage(page, baseUrl, token);
    this.addRepo = new AddRepoPage(page);
  }

  private async save(target: Page | Locator, name: string): Promise<void> {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await target.screenshot({ path: join(SCREENSHOT_DIR, name), animations: "disabled" });
  }

  /** Opens a worktree with a chat in front and waits until the layout is usable. */
  async openWorktreeWithChat(worktreeId: string): Promise<void> {
    await test.step(`Open ${worktreeId} with a chat`, async () => {
      await this.chat.goto(worktreeId);
      await this.chat.waitForReady();
      await this.worktree.waitForWorktreeReady(worktreeId);
    });
  }

  /** Dismisses the "install Claude Code hooks" banner, which the docs shots leave out. */
  async dismissHooksBanner(): Promise<void> {
    await test.step("Dismiss the agent hooks banner", async () => {
      await this.settings.hooksBannerDismiss.click();
      await expect(this.settings.hooksBanner).toBeHidden();
    });
  }

  /** Sends a prompt and waits for the agent's reply to show. */
  async converse(prompt: string, replyFragment: string): Promise<void> {
    await test.step("Have a short conversation", async () => {
      await this.chat.typeMessage(prompt);
      await this.chat.submit();
      await expect(this.chat.assistantMessage(replyFragment)).toBeVisible({ timeout: 20_000 });
      await expect(this.chat.thinkingIndicator).toBeHidden();
    });
  }

  /** Waits until the sidebar shows a card for each worktree, then lets the status dots settle. */
  async waitForSidebar(worktreeIds: string[]): Promise<void> {
    for (const id of worktreeIds) {
      await expect(this.worktree.worktreeCard(id)).toBeVisible({ timeout: 15_000 });
    }
  }

  async shootPage(name: string): Promise<void> {
    await test.step(`Save ${name}`, () => this.save(this.page, name));
  }

  async shootSettings(name: string): Promise<void> {
    await test.step(`Save ${name}`, () => this.save(this.settings.dialog, name));
  }

  /** The Add repo dialog on its "From a worker" tab, showing the worker's folders. */
  async shootAddRepo(name: string, workerId: string, folder: string): Promise<void> {
    await this.addRepo.open();
    await this.addRepo.chooseWorker(workerId);
    await this.addRepo.openFolder(folder);
    await expect(this.page.getByTestId("add-repo__folders")).toBeVisible();
    await expect(this.page.getByTestId("add-repo__picker-entry").first()).toBeVisible();
    await test.step(`Save ${name}`, () =>
      this.save(this.page.getByTestId("add-repo__dialog"), name));
  }

  /** The New worktree dialog with the Worker field showing. */
  async shootNewWorktree(
    name: string,
    groupId: string,
    repo: string,
    branch: string,
  ): Promise<void> {
    await test.step(`Open New worktree from the group ${groupId}`, async () => {
      await this.page.getByTestId(`repo-list__group-add--${groupId}`).click();
      await this.page.getByTestId(`group-pick-repo__item--${repo}`).click();
      await expect(this.worktree.newWorktreeDialog).toBeVisible();
    });
    await expect(this.worktree.newWorktreeHostSelect).toBeVisible();
    await this.worktree.newWorktreeDialog.getByTestId("new-worktree-form__branch").fill(branch);
    await test.step(`Save ${name}`, () => this.save(this.worktree.newWorktreeDialog, name));
  }

  /** The Changes tab of the right sidepanel, once it lists changed files. */
  async shootChanges(name: string): Promise<void> {
    await this.worktree.revealRightPanel();
    await this.worktree.selectRightSidepanelTab("changes");
    await expect(this.worktree.changesSection).toBeVisible({ timeout: 15_000 });
    await expect(this.worktree.rightSidepanel).not.toContainText("Loading commits");
    await test.step(`Save ${name}`, () => this.save(this.page, name));
  }

  /** Settings > Devices with one device in the list. */
  async shootDevices(name: string, label: string): Promise<void> {
    await this.settings.goto();
    await this.settings.openDialog("devices");
    await this.settings.addDevice(label);
    await this.settings.pairingResult().waitFor();
    await this.settings.closePairing();
    await expect(this.settings.deviceRow(label)).toBeVisible();
    await this.shootSettings(name);
  }

  /** Settings > Workers with every worker named in `names` listed. */
  async shootWorkers(name: string, names: string[]): Promise<void> {
    await this.settings.goto();
    await this.settings.openDialog("hosts");
    for (const worker of names) {
      await expect(this.settings.dialog.getByText(worker).first()).toBeVisible();
    }
    await this.shootSettings(name);
  }

  async shootGeneralSettings(name: string): Promise<void> {
    await this.settings.goto();
    await this.settings.openDialog("general");
    await expect(this.settings.sectionCards().first()).toBeVisible();
    await this.shootSettings(name);
  }
}
