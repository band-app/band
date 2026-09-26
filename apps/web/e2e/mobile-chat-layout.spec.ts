/**
 * Mobile layout of the chat and the screen-edge bars.
 *
 * Safe-area insets: an iOS home-screen app (display-mode: standalone,
 * `viewport-fit=cover`) reports a non-zero `env(safe-area-inset-bottom)` for
 * the home indicator. Each inset must be padded once, by the element that
 * touches that screen edge. On a mobile workspace that is the bottom bar; the
 * chat composer sits above it and must keep its own 16 px bottom padding.
 * The composer used to swap that padding for the inset in standalone mode,
 * so the home indicator gap appeared twice. The dashboard action bar clears
 * the inset itself full screen and in the mobile fly-out; in the wide layout
 * the AppShell below the sidebar pads it. The Explorer / Changes sheets and
 * the Settings drawer footer reach the bottom edge and pad it too.
 *
 * Horizontal fit: on a 375 or 390 px screen, long model / mode / config names
 * and long plan entries must truncate or wrap inside the composer, never push
 * the send button or the page past the screen edge.
 *
 * Standalone mode can't be emulated in Playwright's headless shell
 * (`Emulation.setEmulatedMedia` ignores `display-mode`), so the standalone
 * test launches the full Chromium build in app mode (`--app=<url>`), which
 * reports `display-mode: standalone` like a home-screen app. The safe-area
 * inset comes from CDP's `Emulation.setSafeAreaInsetsOverride`.
 *
 * Real server, no tRPC mocking; the ACP stub agent is the only stub.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
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
// `pb-4` on the composer wrapper in ChatView.
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
  seedState(tmpHome, { projects });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });

  // Option names as long as real agents report them, plus a third picker, so
  // the composer toolbar has more to show than a phone screen fits.
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

test.afterAll(async () => {
  await server?.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

/** Launch Chromium as an app window (display-mode: standalone) with a
 *  home-indicator inset. */
async function launchStandalone(viewport: {
  width: number;
  height: number;
}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    viewport,
    args: [`--app=${MobileLayoutPage.dashboardUrl(server.url, TOKEN)}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  // Not in Playwright's bundled protocol types yet.
  await cdp.send(
    "Emulation.setSafeAreaInsetsOverride" as never,
    { insets: { top: SAFE_AREA_TOP, bottom: SAFE_AREA_BOTTOM } } as never,
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

  test("the bottom bar pads the home indicator once and the chat composer keeps its own padding", async () => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await chat.goto(WORKSPACE);
    await chat.waitForReady();

    const viewport = await layout.readViewport();
    expect(viewport.standalone).toBe(true);

    const bar = await layout.readLayout(layout.bottomBar);
    expect(bar.bottom).toBe(viewport.height);
    expect(bar.paddingBottom).toBe(SAFE_AREA_BOTTOM);

    const composer = await layout.readLayout(layout.composer);
    expect(composer.bottom).toBe(bar.top);
    expect(composer.paddingBottom).toBe(COMPOSER_PADDING_BOTTOM);
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
    const message = chat.userMessage("Look at this picture");
    await expect(message).toBeVisible();

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

    // The sidebar column pads the inset itself, so the gap under its action
    // bar is painted in the sidebar colour rather than the app background.
    const sidebar = await layout.readLayout(layout.sidebar);
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

test.describe("in a phone browser tab", () => {
  test.use({ viewport: PHONE });

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
      await expect(layout.configOptionMenu("effort")).toBeVisible();

      const composer = await layout.readLayout(layout.composer);
      expect(composer.left).toBeGreaterThanOrEqual(0);
      expect(composer.right).toBeLessThanOrEqual(viewport.width);
      expect(composer.horizontalOverflow).toBe(0);

      const controls = [
        layout.modelMenu,
        layout.modeMenu,
        layout.configOptionMenu("effort"),
        layout.submitButton,
      ];
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
