/**
 * Page object for the dashboard inside the desktop window. The window is
 * already on `app://`, so navigation is in-app: the chat page object's `goto`
 * loads a workspace route on the window's own origin.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { ChatPanePage } from "../../e2e/pages/ChatPanePage";

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

  /** A workspace's card in the sidebar. */
  workspaceCard(workspaceId: string): Locator {
    return this.page.getByTestId(`project-list__workspace-card--${workspaceId}`);
  }

  /** A project's header row in the sidebar. */
  projectHeader(projectName: string): Locator {
    return this.page.getByTestId(`project-list__project-header--${projectName}`);
  }

  /** Open a workspace and wait for its chat pane (a deep link, as a bookmarked route would). */
  async openWorkspace(workspaceId: string): Promise<void> {
    await test.step(`Open workspace ${workspaceId}`, async () => {
      await this.gotoDeepLink(workspaceId);
      // A workspace with no tabs shows an empty state with "New agent"; one
      // with tabs has the "+" button the chat page object uses.
      const emptyStateAgent = this.page.getByRole("button", { name: "New agent" });
      const plus = this.page.getByTestId("workspace-center__new-tab-button").first();
      await expect(plus.or(emptyStateAgent).first()).toBeVisible({ timeout: 30_000 });
      if (await emptyStateAgent.isVisible()) {
        // The button opens a menu of the configured agents.
        await emptyStateAgent.click();
        await this.page.getByRole("menuitem").first().click();
      }
      await this.chat.waitForReady();
    });
  }

  /** Load a workspace route as a fresh navigation, the way a deep link does. */
  async gotoDeepLink(workspaceId: string): Promise<void> {
    await test.step(`Deep link to /workspace/${workspaceId}`, async () => {
      const url = new URL(`/workspace/${encodeURIComponent(workspaceId)}`, this.page.url());
      await this.page.goto(url.toString());
    });
  }

  async reload(): Promise<void> {
    await test.step("Reload the window", async () => {
      await this.page.reload();
    });
  }

  /** The hub's project shows in the sidebar, which proves the UI reached the hub. */
  async expectProjectListed(projectName: string): Promise<void> {
    await expect(this.projectHeader(projectName)).toBeVisible({ timeout: 30_000 });
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

  /** Open a browser tab from the empty workspace's "New browser" button. */
  async openBrowserTab(): Promise<void> {
    await test.step("Open a browser tab", async () => {
      await this.page.getByRole("button", { name: "New browser" }).click();
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
