import { expect, type Locator, type Page, test } from "@playwright/test";

/** Box edges plus the padding that decides where content stops, in CSS px. */
export interface LayoutBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  paddingTop: number;
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
 * The elements that sit on a screen edge (the mobile workspace header with its
 * Explorer / Changes buttons, the editor area and the tree sheets, the
 * dashboard action bar in each of its three homes, the Settings drawer footer)
 * and the chat composer controls that must fit a phone-width screen. Measures them for layout assertions; the
 * chat itself is driven through `ChatPanePage`, the fly-out through
 * `WorkspacePage` and the Settings dialog through `SettingsPage`.
 */
export class MobileLayoutPage {
  /** The mobile workspace header row (project list, workspace switcher,
   *  Explorer / Changes). */
  readonly header: Locator;
  /** The workspace switcher button in the middle of the header. */
  readonly workspaceSwitcher: Locator;
  readonly explorerButton: Locator;
  readonly changesButton: Locator;
  readonly changesBadge: Locator;
  /** The editor area under the header; it reaches the bottom screen edge. */
  readonly main: Locator;
  /** The bottom tab bar the mobile workspace used to have. */
  readonly legacyBottomBar: Locator;
  /** The action bar of the full-screen mobile dashboard. */
  readonly dashboardActionBar: Locator;
  /** The action bar inside the mobile project-list fly-out. */
  readonly flyoutActionBar: Locator;
  /** The wide-layout project-list sidebar column. */
  readonly sidebar: Locator;
  /** The action bar at the foot of the wide-layout project-list sidebar. */
  readonly sidebarActionBar: Locator;
  /** The wide-layout column right of the sidebar (tabs, chat, side panel). */
  readonly appShellMain: Locator;
  /** The wide-layout sidebar toggle and back / forward buttons. */
  readonly navOverlay: Locator;
  /** The notice asking to add an outdated iOS home-screen app again. */
  readonly reinstallNotice: Locator;
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
    this.header = page.getByTestId("mobile-workspace__header");
    this.workspaceSwitcher = page.getByTestId("mobile-workspace__switcher");
    this.explorerButton = page.getByTestId("mobile-workspace__header-explorer");
    this.changesButton = page.getByTestId("mobile-workspace__header-changes");
    this.changesBadge = page.getByTestId("mobile-workspace__header-changes-badge");
    this.main = page.getByTestId("mobile-workspace__main");
    this.legacyBottomBar = page.getByTestId("mobile-workspace__bottom-bar");
    this.dashboardActionBar = page
      .getByTestId("project-list__action-bar")
      .filter({ visible: true });
    this.flyoutActionBar = page
      .getByTestId("project-list-flyout")
      .getByTestId("project-list__action-bar")
      .filter({ visible: true });
    this.sidebar = page.getByTestId("app-shell__sidebar");
    this.sidebarActionBar = page
      .getByTestId("app-shell__sidebar")
      .getByTestId("project-list__action-bar")
      .filter({ visible: true });
    this.appShellMain = page.getByTestId("app-shell__main");
    this.navOverlay = page.getByTestId("app-shell__nav-overlay");
    this.reinstallNotice = page.getByTestId("reinstall-home-screen-notice");
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

  /** Open the Explorer or Changes bottom sheet from its header button. */
  async openSheet(sheet: "explorer" | "changes"): Promise<void> {
    await test.step(`Open the ${sheet} sheet`, async () => {
      await (sheet === "explorer" ? this.explorerButton : this.changesButton).click();
      const body = sheet === "explorer" ? this.explorerSheetBody : this.changesSheetBody;
      await expect(body).toBeVisible();
    });
  }

  /** Dismiss the add-to-Home-Screen-again notice. */
  async dismissReinstallNotice(): Promise<void> {
    await test.step("Dismiss the reinstall notice", async () => {
      await this.reinstallNotice.getByRole("button", { name: "Close" }).click();
      await expect(this.reinstallNotice).toHaveCount(0);
    });
  }

  /** Resize the window, as turning the device does, and wait for the page to
   *  see the new size. */
  async rotate(size: { width: number; height: number }): Promise<void> {
    await test.step(`Resize to ${size.width}x${size.height}`, async () => {
      await this.page.setViewportSize(size);
      await expect.poll(() => this.page.evaluate(() => window.innerWidth)).toBe(size.width);
    });
  }

  /** Close the open Explorer / Changes sheet, back to the editor. */
  async closeSheet(): Promise<void> {
    await test.step("Close the bottom sheet", async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.explorerSheetBody).toBeHidden();
      await expect(this.changesSheetBody).toBeHidden();
    });
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
        paddingTop: Number.parseFloat(getComputedStyle(el).paddingTop),
        paddingBottom: Number.parseFloat(getComputedStyle(el).paddingBottom),
        horizontalOverflow: el.scrollWidth - el.clientWidth,
      };
    });
  }

  /** The `apple-mobile-web-app-status-bar-style` the page asks iOS for. */
  async readStatusBarStyle(): Promise<string | null> {
    return await this.page.evaluate(
      () =>
        document
          .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
          ?.getAttribute("content") ?? null,
    );
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
