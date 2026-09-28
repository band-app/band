/**
 * Mobile layout of the chat and the screen-edge bars.
 *
 * Safe-area insets: an iOS home-screen app (display-mode: standalone,
 * `viewport-fit=cover`) reports non-zero `env(safe-area-inset-*)` values for
 * the status bar and the home indicator. Each inset must be padded once, by
 * the element that touches that screen edge. On a mobile workspace the header
 * pads the top inset and the editor area pads the bottom one; there is no
 * bottom tab bar (Explorer / Changes are header buttons), so the chat
 * composer sits directly on the home-indicator inset. The dashboard action bar clears
 * the inset itself full screen and in the mobile fly-out; in the wide layout
 * the AppShell below the sidebar pads it. The Explorer / Changes sheets and
 * the Settings drawer footer reach the bottom edge and pad it too.
 *
 * Horizontal fit: on a 375 or 390 px screen, long model / mode / config names
 * and long plan entries must truncate or wrap inside the composer, never push
 * the send button or the page past the screen edge.
 *
 * The page must not ask for the `black-translucent` status bar: on iOS 26 that
 * style sizes a home-screen app one status bar short (WebKit bug 301108), which
 * no inset in the page can correct. An iOS home-screen app that still has
 * that style (iOS reads it only when the app is added) shows a notice asking
 * the user to add it again. Keyboard behaviour (the composer resting on
 * the software keyboard) needs a real iPhone and is checked by hand.
 *
 * Standalone mode can't be emulated in Playwright's headless shell
 * (`Emulation.setEmulatedMedia` ignores `display-mode`), so the standalone
 * test launches the full Chromium build in app mode (`--app=<url>`), which
 * reports `display-mode: standalone` like a home-screen app. The safe-area
 * inset comes from CDP's `Emulation.setSafeAreaInsetsOverride`.
 *
 * Real server, no tRPC mocking; the ACP stub agent is the only stub.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import { git, gitCommit } from "./helpers/git";
import { expectNoKeyboardSuggestions } from "./helpers/keyboard-suggestions";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";
import { MobileLayoutPage } from "./pages/MobileLayoutPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-mobile-chat-layout-token";
const PROJECT = "mobilelayout";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
// In an app-mode window `window.innerHeight` is the full screen height, so an
// element that clears the home indicator ends at `innerHeight - SAFE_AREA_BOTTOM`.
const SAFE_AREA_BOTTOM = 34;
const SAFE_AREA_TOP = 47;
const PHONE = { width: 390, height: 844 };
const TABLET = { width: 1280, height: 800 };
const NARROW_SCREENS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
];
/** One project per narrow screen, so each test's chat starts empty and the
 *  plan it measures is its own. */
const narrowProject = (width: number) => `narrow${width}`;
// `pb-2 lg:pb-4` on the composer wrapper in ChatView: a small gap on a phone,
// where the composer rests on the inset, the original 16 px on a wide screen.
const PHONE_COMPOSER_PADDING_BOTTOM = 8;
const COMPOSER_PADDING_BOTTOM = 16;
// `lg:pb-3` on the Settings DialogFooter, where the dialog is a floating card.
const SETTINGS_CARD_FOOTER_PADDING = 12;
// The full-screen dashboard's minimum bottom gap, `max(1rem, inset)`.
const DASHBOARD_BOTTOM_GAP = 16;
// A 1x1 PNG, the smallest image the composer accepts as an attachment.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const projects = [PROJECT, ...NARROW_SCREENS.map((v) => narrowProject(v.width))].map((name) => {
    const repoDir = join(tmpHome, name);
    mkdirSync(repoDir, { recursive: true });
    return {
      name,
      path: repoDir,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: repoDir }],
    };
  });
  // One uncommitted file in the main project, for the Changes badge.
  const mainRepo = join(tmpHome, PROJECT);
  git(mainRepo, ["init", "-b", "main"]);
  writeFileSync(join(mainRepo, "README.md"), "# Mobile layout\n");
  gitCommit(mainRepo, "initial commit");
  writeFileSync(join(mainRepo, "notes.md"), "draft\n");
  seedState(tmpHome, { projects });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });

  // Option names as long as real agents report them, including a long effort
  // name in the model menu trigger, so the composer toolbar has more to show
  // than a phone screen fits.
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      options: {
        models: [{ value: "opus", name: "Opus 4.7 with the 1M token context window" }],
        modes: [{ value: "bypass", name: "Bypass permissions for every tool call" }],
        extra: [
          {
            id: "effort",
            name: "Reasoning effort",
            options: [{ value: "xhigh", name: "Extra high reasoning effort" }],
          },
        ],
      },
      turns: [
        {
          match: "Plan the work",
          steps: [
            {
              update: {
                sessionUpdate: "plan",
                entries: [
                  {
                    content:
                      "Deploy_the_service_to_production_behind_a_feature_flag_named_mobile_layout",
                    priority: "high",
                    status: "in_progress",
                  },
                  { content: "Write tests", priority: "low", status: "pending" },
                ],
              },
            },
            { say: "Plan ready." },
          ],
        },
      ],
    }),
  });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server?.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

/** Launch Chromium as an app window (display-mode: standalone) with the
 *  status-bar and home-indicator insets. `ios` also sets
 *  `navigator.standalone`, the property only an iOS home-screen app has. */
async function launchStandalone(
  viewport: { width: number; height: number },
  opts: { insetTop?: number; ios?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    viewport,
    args: [`--app=${MobileLayoutPage.dashboardUrl(server.url, TOKEN)}`],
  });
  if (opts.ios) {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "standalone", { get: () => true });
    });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  // Not in Playwright's bundled protocol types yet.
  await cdp.send(
    "Emulation.setSafeAreaInsetsOverride" as never,
    { insets: { top: opts.insetTop ?? SAFE_AREA_TOP, bottom: SAFE_AREA_BOTTOM } } as never,
  );
  return { context, page };
}

test.describe("safe-area insets in a home-screen app", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeEach(async () => {
    ({ context, page } = await launchStandalone(PHONE));
  });

  test.afterEach(async () => {
    await context?.close();
  });

  test("the header clears the status bar and the chat composer rests on the home indicator", async () => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await chat.goto(WORKSPACE);
    await chat.waitForReady();

    const viewport = await layout.readViewport();
    expect(viewport.standalone).toBe(true);
    expect(await layout.readStatusBarStyle()).toBe("black");
    // Not an iOS home-screen app (no `navigator.standalone`), so a top inset
    // alone doesn't ask for a reinstall.
    await expect(layout.reinstallNotice).toHaveCount(0);

    const header = await layout.readLayout(layout.header);
    expect(header.top).toBe(0);
    expect(header.paddingTop).toBe(SAFE_AREA_TOP);
    const title = await layout.readLayout(layout.workspaceSwitcher);
    expect(title.top).toBeGreaterThanOrEqual(SAFE_AREA_TOP);

    // No bottom tab bar: the editor area reaches the bottom edge and pads
    // the inset once, and the composer sits right on it.
    await expect(layout.legacyBottomBar).toHaveCount(0);
    const main = await layout.readLayout(layout.main);
    expect(main.bottom).toBe(viewport.height);
    expect(main.paddingBottom).toBe(SAFE_AREA_BOTTOM);

    const composer = await layout.readLayout(layout.composer);
    expect(composer.bottom).toBe(viewport.height - SAFE_AREA_BOTTOM);
    expect(composer.paddingBottom).toBe(PHONE_COMPOSER_PADDING_BOTTOM);
  });

  test("the dashboard action bar clears the home indicator", async () => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    await layout.gotoDashboard();
    await expect(layout.dashboardActionBar).toBeVisible();

    const viewport = await layout.readViewport();
    expect(viewport.standalone).toBe(true);
    const actionBar = await layout.readLayout(layout.dashboardActionBar);
    expect(actionBar.bottom).toBe(viewport.height - SAFE_AREA_BOTTOM);
  });

  test("the project-list fly-out action bar clears the home indicator", async () => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    await workspace.goto(WORKSPACE);
    await workspace.waitForMobileReady();
    await workspace.openProjectListFlyout();

    const viewport = await layout.readViewport();
    const actionBar = await layout.readLayout(layout.flyoutActionBar);
    expect(actionBar.bottom).toBe(viewport.height - SAFE_AREA_BOTTOM);
  });

  test("the Explorer and Changes sheets pad the home indicator", async () => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    await workspace.goto(WORKSPACE);
    await workspace.waitForMobileReady();

    await layout.openSheet("explorer");
    const explorer = await layout.readLayout(layout.explorerSheetBody);
    expect(explorer.paddingBottom).toBe(SAFE_AREA_BOTTOM);
    await layout.closeSheet();

    await layout.openSheet("changes");
    const changes = await layout.readLayout(layout.changesSheetBody);
    expect(changes.paddingBottom).toBe(SAFE_AREA_BOTTOM);
  });

  test("the full-screen file preview pads the home indicator", async () => {
    const chat = new ChatPanePage(page, server.url, TOKEN);
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    await chat.goto(WORKSPACE);
    await chat.waitForReady();
    await chat.attachFile({ name: "pixel.png", mimeType: "image/png", buffer: PIXEL_PNG });
    await chat.typeMessage("Look at this picture");
    await chat.submit();
    // Wait for the turn to end: the confirmed message replaces the optimistic
    // one, which would unmount a preview opened on it.
    await expect(chat.assistantMessage('Heard "Look at this picture"')).toBeVisible();
    const message = chat.userMessage("Look at this picture");

    await chat.openImagePreview(message);
    const content = await layout.readLayout(chat.filePreviewContent);
    expect(content.paddingBottom).toBe(SAFE_AREA_BOTTOM);
  });

  test("the Settings drawer footer pads the home indicator", async () => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const settings = new SettingsPage(page, server.url, TOKEN);
    await settings.goto();
    await settings.openDialog();
    await expect(settings.dialog).toHaveAttribute("data-variant", "bottom-sheet");

    const footer = await layout.readLayout(settings.footer);
    expect(footer.paddingBottom).toBe(SAFE_AREA_BOTTOM);
  });
});

test.describe("safe-area insets in a wide home-screen app", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeEach(async () => {
    ({ context, page } = await launchStandalone(TABLET));
  });

  test.afterEach(async () => {
    await context?.close();
  });

  test("the app shell pads the home indicator once for the sidebar and the chat", async () => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await chat.goto(WORKSPACE);
    await chat.waitForReady();

    const viewport = await layout.readViewport();
    expect(viewport.standalone).toBe(true);

    // Both columns and the nav buttons over them start below the status bar,
    // so the title bars and the tab strip are not drawn under it.
    const sidebar = await layout.readLayout(layout.sidebar);
    expect(sidebar.top).toBe(0);
    expect(sidebar.paddingTop).toBe(SAFE_AREA_TOP);
    const mainColumn = await layout.readLayout(layout.appShellMain);
    expect(mainColumn.top).toBe(0);
    expect(mainColumn.paddingTop).toBe(SAFE_AREA_TOP);
    const nav = await layout.readLayout(layout.navOverlay);
    expect(nav.top).toBe(SAFE_AREA_TOP);

    // The sidebar column pads the inset itself, so the gap under its action
    // bar is painted in the sidebar colour rather than the app background.
    expect(sidebar.paddingBottom).toBe(SAFE_AREA_BOTTOM);
    const sidebarBar = await layout.readLayout(layout.sidebarActionBar);
    expect(sidebarBar.bottom).toBe(viewport.height - SAFE_AREA_BOTTOM);

    // Exactly one inset below the chat: a second one would lift it further.
    const composer = await layout.readLayout(layout.composer);
    expect(composer.bottom).toBe(viewport.height - SAFE_AREA_BOTTOM);
    expect(composer.paddingBottom).toBe(COMPOSER_PADDING_BOTTOM);
  });

  test("the Settings card keeps its own footer padding", async () => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const settings = new SettingsPage(page, server.url, TOKEN);
    await settings.goto();
    await settings.openDialog();
    // A floating card: it does not reach the bottom screen edge.
    const box = await settings.dialogBox();
    expect(box.y + box.height).toBeLessThan(TABLET.height - SAFE_AREA_BOTTOM);

    const footer = await layout.readLayout(settings.footer);
    expect(footer.paddingBottom).toBe(SETTINGS_CARD_FOOTER_PADDING);
  });
});

test.describe("an iOS home-screen app added with the old status bar", () => {
  let context: BrowserContext;
  let page: Page;

  test.afterEach(async () => {
    await context?.close();
  });

  test("asks the user to add the app again, and stays dismissed", async () => {
    // A top inset in an iOS home-screen app means the translucent status bar
    // iOS froze at install time; the current opaque one reports none.
    ({ context, page } = await launchStandalone(PHONE, { ios: true }));
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await chat.goto(WORKSPACE);
    await chat.waitForReady();

    await expect(layout.reinstallNotice).toBeVisible();
    const viewport = await layout.readViewport();
    const notice = await layout.readLayout(layout.reinstallNotice);
    expect(notice.bottom).toBeLessThanOrEqual(viewport.height - SAFE_AREA_BOTTOM);
    // The toast stack moves above the composer instead of covering it.
    const composer = await layout.readLayout(layout.composer);
    expect(notice.bottom).toBeLessThanOrEqual(composer.top);

    // Turning the device doesn't bring a dismissed notice back.
    await layout.dismissReinstallNotice();
    await layout.rotate({ width: PHONE.height, height: PHONE.width });
    await layout.rotate(PHONE);
    await expect(chat.promptInput).toBeVisible();
    await expect(layout.reinstallNotice).toHaveCount(0);

    await chat.goto(WORKSPACE);
    await chat.waitForReady();
    await expect(layout.reinstallNotice).toHaveCount(0);
  });

  test("stays hidden in an app added with the opaque status bar", async () => {
    ({ context, page } = await launchStandalone(PHONE, { ios: true, insetTop: 0 }));
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await chat.goto(WORKSPACE);
    await chat.waitForReady();

    const header = await layout.readLayout(layout.header);
    expect(header.paddingTop).toBe(0);
    await expect(layout.reinstallNotice).toHaveCount(0);
  });
});

test.describe("in a phone browser tab", () => {
  test.use({ viewport: PHONE });

  test("Explorer and Changes are header buttons that open their sheet and return to the editor", async ({
    page,
  }) => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await chat.goto(WORKSPACE);
    await chat.waitForReady();

    await expect(layout.legacyBottomBar).toHaveCount(0);
    const header = await layout.readLayout(layout.header);
    const title = await layout.readLayout(layout.workspaceSwitcher);
    for (const button of [layout.explorerButton, layout.changesButton]) {
      const box = await layout.readLayout(button);
      expect(box.top).toBeGreaterThanOrEqual(header.top);
      expect(box.bottom).toBeLessThanOrEqual(header.bottom);
      expect(box.left).toBeGreaterThanOrEqual(title.right);
      expect(box.right).toBeLessThanOrEqual(PHONE.width);
    }
    await expect(layout.changesBadge).toHaveText("1");

    // The modal sheet hides the header from the accessibility tree while open.
    await layout.openSheet("changes");
    await layout.closeSheet();
    await expect(layout.changesButton).toHaveAttribute("aria-pressed", "false");
    await expect(chat.promptInput).toBeVisible();

    await layout.openSheet("explorer");
    await layout.closeSheet();
    await expect(layout.explorerButton).toHaveAttribute("aria-pressed", "false");
    await expect(chat.promptInput).toBeVisible();
  });

  test("the chat composer fills to the bottom edge and turns off keyboard suggestions", async ({
    page,
  }) => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await chat.goto(WORKSPACE);
    await chat.waitForReady();

    const viewport = await layout.readViewport();
    const composer = await layout.readLayout(layout.composer);
    expect(composer.bottom).toBe(viewport.height);

    await expectNoKeyboardSuggestions(chat.promptInput);
    await expect(chat.promptInput).toHaveAttribute("writingsuggestions", "false");
    await expect(chat.promptForm).toHaveAttribute("autocomplete", "off");
  });

  test("the dashboard action bar keeps its gap above the bottom edge", async ({ page }) => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    await layout.gotoDashboard();
    await expect(layout.dashboardActionBar).toBeVisible();

    const viewport = await layout.readViewport();
    expect(viewport.standalone).toBe(false);
    const actionBar = await layout.readLayout(layout.dashboardActionBar);
    expect(actionBar.bottom).toBe(viewport.height - DASHBOARD_BOTTOM_GAP);
  });
});

for (const viewport of NARROW_SCREENS) {
  test.describe(`chat fits a ${viewport.width}px wide screen`, () => {
    test.use({ viewport });

    test("composer controls and plan entries stay inside the screen", async ({ page }) => {
      const layout = new MobileLayoutPage(page, server.url, TOKEN);
      const chat = new ChatPanePage(page, server.url, TOKEN);
      await chat.goto(toWorkspaceId(narrowProject(viewport.width), "main"));
      await chat.waitForReady();
      await chat.typeMessage("Plan the work");
      await chat.submit();
      await expect(chat.assistantMessage("Plan ready.")).toBeVisible();
      await expect(layout.taskListEntries).toHaveCount(2);
      await expect(layout.modelMenu).toContainText("Extra high reasoning effort");

      const composer = await layout.readLayout(layout.composer);
      expect(composer.left).toBeGreaterThanOrEqual(0);
      expect(composer.right).toBeLessThanOrEqual(viewport.width);
      expect(composer.horizontalOverflow).toBe(0);

      const controls = [layout.modelMenu, layout.modeMenu, layout.submitButton];
      for (const control of controls) {
        const box = await layout.readLayout(control);
        expect(box.left).toBeGreaterThanOrEqual(composer.left);
        expect(box.right).toBeLessThanOrEqual(composer.right);
      }

      const widget = await layout.readLayout(layout.taskListWidget);
      expect(widget.right).toBeLessThanOrEqual(composer.right);
      for (const entry of await layout.taskListEntries.all()) {
        const box = await layout.readLayout(entry);
        expect(box.right).toBeLessThanOrEqual(widget.right);
        expect(box.horizontalOverflow).toBe(0);
      }

      const screen = await layout.readViewport();
      expect(screen.scrollWidth).toBe(screen.width);
    });
  });
}
