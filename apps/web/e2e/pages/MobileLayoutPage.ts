import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ProjectTab } from "./ProjectsPage";

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
 * The elements that sit on a screen edge (the mobile worktree header with its
 * panel menu button, the editor area and the tree sheets, the
 * dashboard action bar in each of its three homes, the Settings drawer footer)
 * and the chat composer controls that must fit a phone-width screen. Measures them for layout assertions; the
 * chat itself is driven through `ChatPanePage`, the fly-out through
 * `WorktreePage` and the Settings dialog through `SettingsPage`.
 */
export class MobileLayoutPage {
  /** The mobile worktree header row (repo list, worktree switcher,
   *  Explorer / Changes). */
  readonly header: Locator;
  /** The worktree switcher button in the middle of the header. */
  readonly worktreeSwitcher: Locator;
  /** The header label's first row: the worktree (worktree) name. */
  readonly headerWorktreeName: Locator;
  /** The header label's second row: the repo name. */
  readonly headerRepoName: Locator;
  /** The header label, both rows. */
  readonly headerLabel: Locator;
  /** The top row of the repo-list fly-out (label filter, add repo). */
  readonly flyoutTopBar: Locator;
  /** The vertical 3-dot button at the right of the header; it opens the
   *  panel menu (Explorer, Changes, plugin tabs) as a bottom drawer. */
  readonly menuButton: Locator;
  /** The body of the panel menu's bottom drawer. */
  readonly menuBody: Locator;
  /** The changed-file count on the menu's Changes row. */
  readonly changesItemBadge: Locator;
  /** The editor area under the header; it reaches the bottom screen edge. */
  readonly main: Locator;
  /** The bottom tab bar the mobile worktree used to have. */
  readonly legacyBottomBar: Locator;
  /** The action bar of the full-screen mobile dashboard. */
  readonly dashboardActionBar: Locator;
  /** The action bar inside the mobile repo-list fly-out. */
  readonly flyoutActionBar: Locator;
  /** The wide-layout repo-list sidebar column. */
  readonly sidebar: Locator;
  /** The action bar at the foot of the wide-layout repo-list sidebar. */
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
    this.header = page.getByTestId("mobile-worktree__header");
    this.worktreeSwitcher = page.getByTestId("mobile-worktree__switcher");
    this.headerWorktreeName = this.worktreeSwitcher.getByTestId("worktree-label__name");
    this.headerRepoName = this.worktreeSwitcher.getByTestId("worktree-label__repo");
    this.headerLabel = this.worktreeSwitcher.getByTestId("worktree-label");
    this.flyoutTopBar = page.getByTestId("repo-list-flyout").getByTestId("repo-list__top-bar");
    this.menuButton = page.getByTestId("mobile-worktree__header-menu");
    this.menuBody = page.getByTestId("mobile-worktree__menu-body");
    this.changesItemBadge = page.getByTestId("mobile-worktree__menu-changes-badge");
    this.main = page.getByTestId("mobile-worktree__main");
    this.legacyBottomBar = page.getByTestId("mobile-worktree__bottom-bar");
    this.dashboardActionBar = page.getByTestId("repo-list__action-bar").filter({ visible: true });
    this.flyoutActionBar = page
      .getByTestId("repo-list-flyout")
      .getByTestId("repo-list__action-bar")
      .filter({ visible: true });
    this.sidebar = page.getByTestId("app-shell__sidebar");
    this.sidebarActionBar = page
      .getByTestId("app-shell__sidebar")
      .getByTestId("repo-list__action-bar")
      .filter({ visible: true });
    this.appShellMain = page.getByTestId("app-shell__main");
    this.navOverlay = page.getByTestId("app-shell__nav-overlay");
    this.reinstallNotice = page.getByTestId("reinstall-home-screen-notice");
    this.explorerSheetBody = page.getByTestId("mobile-worktree__explorer-body");
    this.changesSheetBody = page.getByTestId("mobile-worktree__changes-body");
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

  /** Open the dashboard (the repo list, full screen on mobile). */
  async gotoDashboard(): Promise<void> {
    await test.step("Navigate to the dashboard", async () => {
      await this.page.goto(MobileLayoutPage.dashboardUrl(this.baseUrl, this.token));
    });
  }

  /** A row of the panel menu: `explorer`, `changes`, or a plugin tab's
   *  `<pluginId>-<tabId>` slug (the GitHub Checks tab is
   *  `github-pull-request`). */
  menuItem(item: string): Locator {
    return this.page.getByTestId(`mobile-worktree__menu-${item}`);
  }

  /** Open the panel menu's bottom drawer from the header's 3-dot button. */
  async openMenu(): Promise<void> {
    await test.step("Open the worktree panel menu", async () => {
      await this.menuButton.click();
      await expect(this.menuBody).toBeVisible();
    });
  }

  /** Close the panel menu's bottom drawer without choosing a panel. */
  async closeMenu(): Promise<void> {
    await test.step("Close the worktree panel menu", async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.menuBody).toBeHidden();
    });
  }

  /** Open the Explorer or Changes bottom sheet through the panel menu. */
  async openSheet(sheet: "explorer" | "changes"): Promise<void> {
    await test.step(`Open the ${sheet} sheet`, async () => {
      await this.openMenu();
      await this.menuItem(sheet).click();
      const body = sheet === "explorer" ? this.explorerSheetBody : this.changesSheetBody;
      await expect(body).toBeVisible();
      await expect(this.menuBody).toBeHidden();
    });
  }

  /** The body of a plugin tab's bottom sheet. */
  pluginSheetBody(slug: string): Locator {
    return this.page.getByTestId(`mobile-worktree__plugin--${slug}-body`);
  }

  /** Open a plugin tab's bottom sheet through the panel menu. */
  async openPluginSheet(slug: string): Promise<void> {
    await test.step(`Open the ${slug} sheet`, async () => {
      await this.openMenu();
      await this.menuItem(slug).click();
      await expect(this.pluginSheetBody(slug)).toBeVisible();
      await expect(this.menuBody).toBeHidden();
    });
  }

  /** Close a plugin tab's bottom sheet, back to the editor. */
  async closePluginSheet(slug: string): Promise<void> {
    await test.step(`Close the ${slug} sheet`, async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.pluginSheetBody(slug)).toBeHidden();
    });
  }

  /** The body of a project side tab's bottom sheet (`activity` or `repos`). */
  projectSheetBody(tab: ProjectTab): Locator {
    return this.page.getByTestId(`mobile-worktree__project--${tab}-sheet`);
  }

  /** Open a project side tab's bottom sheet through the panel menu of a project's view. */
  async openProjectSheet(tab: ProjectTab): Promise<void> {
    await test.step(`Open the project's ${tab} sheet`, async () => {
      await this.openMenu();
      await this.menuItem(`project-${tab}`).click();
      await expect(this.projectSheetBody(tab)).toBeVisible();
      await expect(this.menuBody).toBeHidden();
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

  /** Close the open panel menu / Explorer / Changes sheet, back to the
   *  editor. */
  async closeSheet(): Promise<void> {
    await test.step("Close the bottom sheet", async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.explorerSheetBody).toBeHidden();
      await expect(this.changesSheetBody).toBeHidden();
      await expect(this.menuBody).toBeHidden();
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

  /** The href of the `<link rel="manifest">` in the page head. */
  async readManifestHref(): Promise<string | null> {
    return await this.page.evaluate(
      () => document.querySelector('link[rel="manifest"]')?.getAttribute("href") ?? null,
    );
  }

  /** How far the document itself has scrolled. The mobile layout keeps it at
   *  0; only the panes inside scroll. */
  async readDocumentScroll(): Promise<{ x: number; y: number }> {
    return await this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  }

  /** The document's scroll two frames from now, after the scroll events the
   *  last scroll queued have run. */
  async readDocumentScrollAfterFrames(): Promise<{ x: number; y: number }> {
    return await this.page.evaluate(
      () =>
        new Promise<{ x: number; y: number }>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve({ x: window.scrollX, y: window.scrollY })),
          ),
        ),
    );
  }

  /** Give the document room to scroll, as iOS does while the software
   *  keyboard is up: it lets the page scroll by up to the keyboard's height
   *  even when nothing overflows. Headless WebKit has no keyboard, so a tall
   *  element appended after the body stands in for that range. */
  async addKeyboardScrollRange(height: number): Promise<void> {
    await test.step(`Give the document ${height}px of scroll range`, async () => {
      await this.page.evaluate((h) => {
        const spacer = document.createElement("div");
        spacer.style.height = `${h}px`;
        document.documentElement.append(spacer);
      }, height);
    });
  }

  /** Scroll the document, as iOS does to reveal a focused input or after a
   *  fling outside the panes, and report `scrollY` right after the call,
   *  before any scroll listener has run. `readDocumentScroll` and
   *  `readDocumentScrollAfterFrames` tell where the document settles. */
  async scrollDocument(y: number): Promise<{ scrolledTo: number }> {
    return await test.step(`Scroll the document to ${y}px`, async () => {
      return await this.page.evaluate((top) => {
        window.scrollTo(0, top);
        return { scrolledTo: window.scrollY };
      }, y);
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
