/**
 * Page object for a worktree's Simulator tab (the `simulator` plugin's `worktree.panels`
 * contribution, drawn by the core's `RemoteScreen`): the "+" menu entry, the tab, the live canvas
 * and its view-only / control toggle. Test bodies call these methods, never `page.getByTestId`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { ChatPanePage } from "./ChatPanePage";

export class SimulatorPage {
  readonly chat: ChatPanePage;
  readonly newTabButton: Locator;
  readonly menuItem: Locator;
  readonly tab: Locator;
  readonly closeButton: Locator;
  readonly screen: Locator;
  readonly canvas: Locator;
  readonly status: Locator;
  readonly controlToggle: Locator;
  readonly homeButton: Locator;
  /** Not offered: rotate does nothing visible on the current Xcode. */
  readonly rotateButton: Locator;
  readonly revealButton: Locator;
  readonly screenshotButton: Locator;
  readonly toolImage: Locator;
  readonly toolImageFull: Locator;
  readonly openSimulatorButton: Locator;
  private readonly sockets: string[] = [];

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.chat = new ChatPanePage(page, baseUrl, token);
    this.newTabButton = page.getByTestId("worktree-center__new-tab-button");
    this.menuItem = page.getByTestId("worktree-center__new-tab--simulator-simulator");
    this.tab = page.getByTestId("center-plugin-tab--simulator-simulator");
    this.closeButton = page.getByTestId("center-plugin-tab--simulator-simulator__close");
    this.screen = page.getByTestId("remote-screen");
    this.canvas = page.getByTestId("remote-screen__canvas");
    this.status = page.getByTestId("remote-screen__status");
    this.controlToggle = page.getByTestId("remote-screen__control");
    this.homeButton = page.getByTestId("simulator-panel__home");
    this.rotateButton = page.getByRole("button", { name: "Rotate" });
    this.revealButton = page.getByTestId("simulator-panel__reveal");
    this.screenshotButton = page.getByTestId("remote-screen__screenshot");
    this.toolImage = page.getByTestId("tool-call__image").first();
    this.toolImageFull = page.getByTestId("tool-call__image-full");
    this.openSimulatorButton = page.getByTestId("tool-call__open-simulator").first();
    // Every WebSocket the page opens to the simulator stream, to see whether a tab switch reconnects.
    page.on("websocket", (ws) => {
      if (ws.url().includes("/api/plugins/simulator/")) this.sockets.push(ws.url());
    });
  }

  /** Saves a screenshot of the page to `$BAND_E2E_EVIDENCE_DIR` when it is set (for a task's evidence folder). */
  async saveEvidence(name: string): Promise<void> {
    const dir = process.env.BAND_E2E_EVIDENCE_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    await this.page.screenshot({ path: join(dir, `${name}.png`) });
  }

  /** How many stream connections the page has opened so far. */
  get streamConnections(): number {
    return this.sockets.length;
  }

  async open(worktreeId: string): Promise<void> {
    await test.step(`Open worktree ${worktreeId}`, async () => {
      await this.chat.goto(worktreeId);
      await this.chat.waitForReady();
    });
  }

  async reload(): Promise<void> {
    await test.step("Reload the page", async () => {
      await this.page.reload();
      await this.chat.waitForReady();
    });
  }

  async openNewTabMenu(): Promise<void> {
    await test.step("Open the new-tab menu", async () => {
      await this.newTabButton.first().click();
      await expect(this.page.getByTestId("worktree-center__new-tab-menu")).toBeVisible();
    });
  }

  /** Opens the Simulator tab from the "+" menu. */
  async openFromMenu(): Promise<void> {
    await test.step("Open the Simulator tab from the + menu", async () => {
      await this.openNewTabMenu();
      await this.menuItem.click();
      await expect(this.tab).toBeVisible();
    });
  }

  async waitLive(): Promise<void> {
    await test.step("Wait for the live screen", async () => {
      await expect(this.screen).toHaveAttribute("data-phase", "live", { timeout: 360_000 });
    });
  }

  /** Sends a chat message and waits for the assistant's reply text. */
  async say(message: string, reply: string): Promise<void> {
    await test.step(`Send "${message}"`, async () => {
      await this.chat.typeMessage(message);
      await this.chat.submit();
      await expect(this.chat.assistantMessage(reply)).toBeVisible();
    });
  }

  /** Expands the chat's first tool call. */
  async expandFirstToolCall(): Promise<void> {
    await this.chat.toolCallContainers.first().getByRole("button").first().click();
  }

  /** Selects another tab of the center layout (the first one that is not the Simulator). */
  async selectOtherTab(): Promise<void> {
    await test.step("Select another tab", async () => {
      await this.page.getByRole("tab").filter({ hasNot: this.tab }).first().click();
    });
  }

  async selectTab(): Promise<void> {
    await this.tab.click();
  }

  async takeControl(): Promise<void> {
    await test.step("Take control", async () => {
      await this.controlToggle.click();
      await expect(this.screen).toHaveAttribute("data-controlling", "true");
    });
  }

  async release(): Promise<void> {
    await test.step("Release control", async () => {
      await this.controlToggle.click();
      await expect(this.screen).toHaveAttribute("data-controlling", "false");
    });
  }

  /** A click at a fraction of the canvas. */
  async clickAt(x: number, y: number): Promise<void> {
    const box = await this.canvas.boundingBox();
    if (!box) throw new Error("The canvas is not laid out");
    await this.page.mouse.click(box.x + box.width * x, box.y + box.height * y);
  }

  /** The canvas as a PNG, for telling whether the screen changed. */
  canvasPixels(): Promise<Buffer> {
    return this.canvas.screenshot();
  }

  /** Clicks the screenshot button and returns the download it starts. */
  async saveScreenshot() {
    const [download] = await Promise.all([
      this.page.waitForEvent("download"),
      this.screenshotButton.click(),
    ]);
    return download;
  }

  async closeTab(): Promise<void> {
    await test.step("Close the Simulator tab", async () => {
      await this.tab.hover();
      await this.closeButton.click();
      await expect(this.tab).toHaveCount(0);
    });
  }
}
