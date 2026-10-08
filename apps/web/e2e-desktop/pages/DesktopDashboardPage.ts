/**
 * Page object for the dashboard inside the desktop window. The window is
 * already on `app://`, so navigation is in-app: the chat page object's `goto`
 * loads a worktree route on the window's own origin.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { ChatPanePage } from "../../e2e/pages/ChatPanePage";
import { TerminalSurface } from "../../e2e/pages/TerminalSurface";

export class DesktopDashboardPage {
  readonly chat: ChatPanePage;

  constructor(private readonly page: Page) {
    // Cross-origin hub auth comes from the preload, so no token is passed.
    this.chat = new ChatPanePage(page, "app://placeholder", "");
  }

  /** The window's current `app://` URL. */
  url(): string {
    return this.page.url();
  }

  /** A worktree's card in the sidebar. */
  worktreeCard(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__worktree-card--${worktreeId}`);
  }

  /** A repo's header row in the sidebar. */
  repoHeader(repoName: string): Locator {
    return this.page.getByTestId(`repo-list__repo-header--${repoName}`);
  }

  /** Open a worktree and wait for its chat pane (a deep link, as a bookmarked route would). */
  async openWorktree(worktreeId: string): Promise<void> {
    await test.step(`Open worktree ${worktreeId}`, async () => {
      await this.gotoDeepLink(worktreeId);
      // A worktree with no tabs shows an empty state with "New agent"; one
      // with tabs has the "+" button the chat page object uses.
      const emptyStateAgent = this.page.getByTestId("worktree-center__empty-new-agent");
      const plus = this.page.getByTestId("worktree-center__new-tab-button").first();
      await expect(plus.or(emptyStateAgent).first()).toBeVisible({ timeout: 30_000 });
      if (await emptyStateAgent.isVisible()) {
        // The button opens a menu of the configured agents.
        await emptyStateAgent.click();
        await this.page.getByRole("menuitem").first().click();
      }
      await this.chat.waitForReady();
    });
  }

  /** Show the worktree's terminal, opening one if the worktree has no tabs. */
  async openTerminal(worktreeId: string): Promise<TerminalSurface> {
    return await test.step("Open a terminal tab", async () => {
      await this.gotoDeepLink(worktreeId);
      const terminal = new TerminalSurface(this.page, worktreeId);
      // A worktree opens with a terminal tab unless its tabs are empty, which
      // shows the "New terminal" button instead.
      const emptyStateTerminal = this.page.getByTestId("worktree-center__empty-new-term");
      await expect(terminal.input.or(emptyStateTerminal).first()).toBeVisible({ timeout: 30_000 });
      if (await emptyStateTerminal.isVisible()) await emptyStateTerminal.click();
      await expect(terminal.input).toBeAttached({ timeout: 30_000 });
      return terminal;
    });
  }

  /** Call the folder picker's IPC, the way the Add repo dialog's "Choose folder on this computer" button does. */
  async pickFolderViaIpc(): Promise<string | null> {
    return await this.page.evaluate(async () => {
      const bridge = (
        window as unknown as {
          __BAND_DESKTOP__: { invoke(channel: string): Promise<string | null> };
        }
      ).__BAND_DESKTOP__;
      return await bridge.invoke("pick_folder");
    });
  }

  /** Load a worktree route as a fresh navigation, the way a deep link does. */
  async gotoDeepLink(worktreeId: string): Promise<void> {
    await test.step(`Deep link to /worktree/${worktreeId}`, async () => {
      const url = new URL(`/worktree/${encodeURIComponent(worktreeId)}`, this.page.url());
      await this.page.goto(url.toString());
    });
  }

  async reload(): Promise<void> {
    await test.step("Reload the window", async () => {
      await this.page.reload();
    });
  }

  /** The hub's repo shows in the sidebar, which proves the UI reached the hub. */
  async expectRepoListed(repoName: string): Promise<void> {
    await expect(this.repoHeader(repoName)).toBeVisible({ timeout: 30_000 });
  }

  /** Write a value to this origin's localStorage. */
  async writeStorage(key: string, value: string): Promise<void> {
    await this.page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);
  }

  async readStorage(key: string): Promise<string | null> {
    return await this.page.evaluate((k) => localStorage.getItem(k), key);
  }

  /** Ask the page to navigate itself to a URL, as a hostile or buggy link would. */
  async navigateTo(url: string): Promise<void> {
    await this.page.evaluate((u) => {
      window.location.href = u;
    }, url);
  }

  async openWindow(url: string): Promise<void> {
    await this.page.evaluate((u) => {
      window.open(u, "_blank");
    }, url);
  }

  /**
   * Open a browser tab from the "+" menu, or from the "New browser" button when
   * the worktree has no tabs. A worktree normally opens with a terminal tab.
   */
  async openBrowserTab(): Promise<void> {
    await test.step("Open a browser tab", async () => {
      const emptyState = this.page.getByTestId("worktree-center__empty-new-browser");
      const plus = this.page.getByTestId("worktree-center__new-tab-button").first();
      await expect(plus.or(emptyState).first()).toBeVisible({ timeout: 30_000 });
      if (await emptyState.isVisible()) {
        await emptyState.click();
        return;
      }
      await plus.click();
      await this.page.getByTestId("worktree-center__new-tab--browser").click();
    });
  }

  /**
   * Wait until a browser tab's `<webview>` guest has attached, which needs the
   * main process to admit its partition. Resolves with the guest's
   * `webContents` id.
   */
  async expectBrowserGuestAttached(): Promise<number> {
    const webview = this.page.getByTestId("browser-pane__webview").first();
    await expect(webview).toBeAttached({ timeout: 30_000 });
    let id = 0;
    await expect
      .poll(
        async () => {
          id = await webview.evaluate((el) => {
            try {
              return (el as unknown as { getWebContentsId(): number }).getWebContentsId();
            } catch {
              return 0;
            }
          });
          return id;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    return id;
  }
}
