import { expect, type Locator, type Page, test } from "@playwright/test";

/** Box edges plus the padding that decides where content stops, in CSS px. */
export interface LayoutBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  paddingBottom: number;
  /** How far the content overflows the box sideways (`scrollWidth -
   *  clientWidth`); 0 when it fits. */
  horizontalOverflow: number;
}

/** Viewport facts a mobile layout assertion needs. */
export interface ViewportInfo {
  width: number;
  height: number;
  /** `document.documentElement.scrollWidth`; larger than `width` means the
   *  page scrolls sideways. */
  scrollWidth: number;
  /** Whether `(display-mode: standalone)` matches, i.e. the page runs like a
   *  saved home-screen app. */
  standalone: boolean;
}

/**
 * The elements that sit on the bottom screen edge (the mobile workspace bottom
 * bar and its Explorer / Changes sheets, the dashboard action bar in each of
 * its three homes, the Settings drawer footer) and the chat composer controls
 * that must fit a phone-width screen. Measures them for layout assertions; the
 * chat itself is driven through `ChatPanePage`, the fly-out through
 * `WorkspacePage` and the Settings dialog through `SettingsPage`.
 */
export class MobileLayoutPage {
  readonly bottomBar: Locator;
  /** The action bar of the full-screen mobile dashboard. */
  readonly dashboardActionBar: Locator;
  /** The action bar inside the mobile project-list fly-out. */
  readonly flyoutActionBar: Locator;
  /** The action bar at the foot of the wide-layout project-list sidebar. */
  readonly sidebarActionBar: Locator;
  readonly explorerSheetBody: Locator;
  readonly changesSheetBody: Locator;
  readonly composer: Locator;
  readonly submitButton: Locator;
  readonly modelMenu: Locator;
  readonly modeMenu: Locator;
  readonly taskListWidget: Locator;
  readonly taskListEntries: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.bottomBar = page.getByTestId("mobile-workspace__bottom-bar").filter({ visible: true });
    this.dashboardActionBar = page
      .getByTestId("project-list__action-bar")
      .filter({ visible: true });
    this.flyoutActionBar = page
      .getByTestId("project-list-flyout")
      .getByTestId("project-list__action-bar");
    this.sidebarActionBar = page
      .getByTestId("app-shell__sidebar")
      .getByTestId("project-list__action-bar");
    this.explorerSheetBody = page.getByTestId("mobile-workspace__explorer-body");
    this.changesSheetBody = page.getByTestId("mobile-workspace__changes-body");
    this.composer = page.getByTestId("chat-pane__composer").filter({ visible: true });
    this.submitButton = page.getByTestId("prompt-input__submit-button").filter({ visible: true });
    this.modelMenu = page.getByTestId("chat-pane__model-menu").filter({ visible: true });
    this.modeMenu = page.getByTestId("chat-pane__mode-menu").filter({ visible: true });
    this.taskListWidget = page.getByTestId("task-list-widget__container").filter({ visible: true });
    this.taskListEntries = this.taskListWidget.getByTestId("task-list-widget__entry");
  }

  /** The dashboard URL, also the start URL of an app-mode browser window. */
  static dashboardUrl(baseUrl: string, token: string): string {
    return `${baseUrl}/?token=${token}`;
  }

  /** Open the dashboard (the project list, full screen on mobile). */
  async gotoDashboard(): Promise<void> {
    await test.step("Navigate to the dashboard", async () => {
      await this.page.goto(MobileLayoutPage.dashboardUrl(this.baseUrl, this.token));
    });
  }

  /** Open the Explorer or Changes bottom sheet from the mobile bottom bar. */
  async openSheet(sheet: "explorer" | "changes"): Promise<void> {
    await test.step(`Open the ${sheet} sheet`, async () => {
      await this.page.getByTestId(`mobile-workspace__bar--${sheet}`).click();
      const body = sheet === "explorer" ? this.explorerSheetBody : this.changesSheetBody;
      await expect(body).toBeVisible();
    });
  }

  /** Close the open Explorer / Changes sheet; it covers the bottom bar. */
  async closeSheet(): Promise<void> {
    await test.step("Close the bottom sheet", async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.explorerSheetBody).toBeHidden();
      await expect(this.changesSheetBody).toBeHidden();
    });
  }

  /** A config-option picker in the composer toolbar, e.g. reasoning effort. */
  configOptionMenu(optionId: string): Locator {
    return this.page.getByTestId(`chat-pane__config-option--${optionId}`).filter({ visible: true });
  }

  /** Measure an element once every running animation (sheet slide-ins) has
   *  settled, so the box is the resting position. */
  async readLayout(locator: Locator): Promise<LayoutBox> {
    return await locator.evaluate(async (el) => {
      // Infinite animations (spinners) never finish, so skip them.
      const settling = document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY);
      await Promise.all(settling.map((a) => a.finished.catch(() => {})));
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        paddingBottom: Number.parseFloat(getComputedStyle(el).paddingBottom),
        horizontalOverflow: el.scrollWidth - el.clientWidth,
      };
    });
  }

  async readViewport(): Promise<ViewportInfo> {
    return await this.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      standalone: window.matchMedia("(display-mode: standalone)").matches,
    }));
  }
}
