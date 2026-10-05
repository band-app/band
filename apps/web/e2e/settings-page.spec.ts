import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { type SettingsNavId, SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-settings-test-token";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { projects: [] });
  // Seed codingAgents explicitly so the Default-agent dropdown renders
  // deterministically — without this, runFirstTimeSetup() relies on the
  // host having `claude`/`codex`/`opencode` on PATH, which is true on
  // dev machines but not on CI runners. A model refresh probes the agent
  // over ACP (a scratch session, then its `model` config option); every
  // agent here runs as the ACP stub, so the boot refresh and the explicit
  // Refresh resolve to the stub's two models with no host dependency.
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    theme: "dark",
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex" },
    ],
    defaultCodingAgent: "claude-code",
  });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpHome, ".band", "settings.json"), "utf-8"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("settings opens full screen with one page per sidebar entry", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  // The settings cover the whole window, not a centred card.
  await expect(settingsPage.dialog).toHaveAttribute("data-variant", "fullscreen");
  const viewport = page.viewportSize();
  const box = await settingsPage.dialogBox();
  expect(Math.round(box.width)).toBe(viewport?.width);
  expect(Math.round(box.height)).toBe(viewport?.height);

  // Each sidebar entry shows its own page, anchored on its first row's control. The empty Labels
  // state is anchored on its "Add label" button (the only stable system-controlled name there).
  const pages: Array<[SettingsNavId, () => Locator]> = [
    ["appearance", () => settingsPage.themeSelect()],
    ["general", () => settingsPage.worktreesFolderInput()],
    ["general", () => settingsPage.lspSwitch()],
    ["browser", () => settingsPage.webBrowserCdpSwitch()],
    ["hosts", () => settingsPage.hostRow("local")],
    ["credentials", () => settingsPage.credentialsAddButton()],
    ["labels", () => settingsPage.addLabelButton().first()],
    ["notifications", () => settingsPage.soundOnNeedsAttentionSwitch()],
    ["web-server", () => settingsPage.webServerPortInput()],
    ["web-server", () => settingsPage.autoStartTunnelSwitch()],
    ["terminal", () => settingsPage.webGLTerminalRendererSwitch()],
  ];
  for (const [section, row] of pages) {
    await settingsPage.openSection(section);
    await settingsPage.expectRowVisible(row());
  }

  // A page shows only its own section: with Terminal open, the Appearance theme row is not mounted.
  await expect(settingsPage.themeSelect()).toHaveCount(0);

  // Coding Agents: `SettingsPage.tsx` renders one row per entry in its `KNOWN_AGENTS` constant
  // regardless of what is seeded in `codingAgents`, so OpenCode is visible even though only
  // `claude-code` and `codex` are in the beforeAll seed.
  await settingsPage.openSection("agents");
  for (const agent of ["Claude Code", "Codex", "OpenCode"]) {
    await settingsPage.expectRowVisible(settingsPage.agentEnableSwitch(agent));
  }
  // The "Default coding agent" dropdown only renders when at least one agent is enabled. The
  // `beforeAll` seeds Claude Code as enabled and as the default, so it renders deterministically.
  await settingsPage.expectRowVisible(settingsPage.defaultAgentSelect());
});

test("the sidebar search narrows the page list and Back to app closes settings", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  await settingsPage.searchSections("cred");
  await expect(settingsPage.navEntries()).toHaveCount(1);
  await expect(settingsPage.navEntry("credentials")).toBeVisible();

  await settingsPage.backToApp();
  await expect(settingsPage.dialog).toHaveCount(0);
});

test("the browser build does not offer the translucent sidebar toggle", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("appearance");

  // Positive anchor: the Appearance section rendered its Theme row. The
  // translucent sidebar only works over the macOS desktop window's vibrancy
  // layer, so a browser tab has no toggle for it.
  await expect(settingsPage.themeSelect()).toBeVisible();
  await expect(settingsPage.translucentSidebarSwitch()).toHaveCount(0);
});

test("the General section no longer offers a cached-workspaces count", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("general");

  // Positive anchor: the General section rendered (LSP is one of its rows).
  await settingsPage.expectRowVisible(settingsPage.lspSwitch());
  await expect(settingsPage.cachedWorkspacesInput()).toHaveCount(0);
});

test("toggling LSP and saving persists to settings.json", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("general");

  // Sanity check the starting state, then toggle (the POM asserts the
  // visual state change after the click).
  await expect(settingsPage.lspSwitch()).toHaveAttribute("data-state", "unchecked");
  await settingsPage.toggleLsp();

  // Save (the icon button in the page header).
  await settingsPage.save();

  // Wait for the mutation to complete by polling the persisted JSON.
  await expect(() => {
    const settings = readSettings();
    if (settings.enableLSP !== true) {
      throw new Error(`expected enableLSP=true, got ${JSON.stringify(settings.enableLSP)}`);
    }
  }).toPass({ timeout: 5_000 });
});

test("coding agents section renders and toggling an agent doesn't crash", async ({ page }) => {
  // Regression test for the Radix Select empty-string crash that happened
  // when the Coding Agents section mounted a model dropdown with a "Default"
  // option whose value was the empty string. Radix Select reserves "" for
  // its no-selection state and throws when an item uses it. Toggling the
  // agent on triggers a listModels() call which, if it returns any models,
  // mounts the dropdown and exercises the sentinel-value fix.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("agents");

  // The Coding Agents section is part of the single scrolling list. Scroll
  // to Claude Code's enable switch (the per-agent row label and the
  // default-agent dropdown both contain the text "Claude Code", so use
  // the uniquely-named switch instead).
  const claudeSwitch = settingsPage.agentEnableSwitch("Claude Code");
  await settingsPage.expectRowVisible(claudeSwitch);

  // Toggle Claude Code so listModels() is called and the model Select
  // potentially mounts. The toggle alone is enough to exercise the
  // listModels effect — saving would close the dialog. We don't assume a
  // starting state (the seed enables claude-code, so the switch starts
  // checked; an unseeded test would start unchecked) — instead we record
  // the initial `data-state` and assert it flipped.
  const initialState = await claudeSwitch.getAttribute("data-state");
  const targetState = initialState === "checked" ? "unchecked" : "checked";
  await settingsPage.toggleAgentEnable("Claude Code");

  // Wait for the toggle to take effect at the DOM level. Once the switch
  // reports the flipped `data-state`, React has applied the state update
  // and the `codingAgents`-keyed effect that calls `listModels()` has
  // fired (the auto-retry inside `toHaveAttribute` doubles as a settling
  // window for the SDK-rendered Select). This is the strongest
  // deterministic signal for the toggle itself. Any *synchronous* Radix
  // throw during the re-render would already have hit the `pageerror`
  // listener by the time the data-state attribute flips. The boot refresh
  // cached the ACP stub's models, so the model list can mount with real
  // entries; the `errors` assertion below covers a throw from that render
  // too.
  await expect(claudeSwitch).toHaveAttribute("data-state", targetState);

  // The dialog must still be visible — if Radix had thrown, the React tree
  // would have unmounted into an error boundary.
  await expect(claudeSwitch).toBeVisible();
  expect(errors).toEqual([]);
});

test("clicking Refresh models persists the stub catalog to settings.json", async ({ page }) => {
  // User-observable affordance from the refresh-agent-models change:
  // expanding an agent's accordion in the Settings dialog renders a
  // "Refresh" button + per-agent model list. Clicking the button must
  // (a) populate the model list in the DOM with the agent's catalog
  // and (b) write `cachedModels` + `cachedModelsUpdatedAt` into
  // ~/.band/settings.json for that agent.
  //
  // Codex runs as the ACP stub agent, whose `model` config option offers
  // `stub-small` and `stub-large`, so the round-trip is fully
  // deterministic on every CI host without a real codex install.

  // Record the pre-click `cachedModelsUpdatedAt` value populated by
  // the boot-time refresh; the assertion below requires the explicit
  // click to bump it strictly forward, so a no-op click would fail
  // the test rather than passing on the boot-refresh value alone.
  //
  // We *also* capture a `referenceTs` from `Date.now()` immediately
  // before the click. Comparing against `max(beforeTs, referenceTs)`
  // means the explicit-click write has to land at a real wall-clock
  // tick strictly after the test reaches this point — no sleep needed
  // for the rare case where the boot refresh and the click both happen
  // to fall on the same millisecond.
  const beforeTs = (
    readSettings() as {
      codingAgents?: { id: string; cachedModelsUpdatedAt?: number }[];
    }
  ).codingAgents?.find((a) => a.id === "codex")?.cachedModelsUpdatedAt;
  const referenceTs = Date.now();
  const lowerBound = Math.max(beforeTs ?? 0, referenceTs);

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("agents");

  // Open the Codex accordion so the model list + Refresh button mount.
  await settingsPage.expandAgentAccordion("Codex");

  // Click Refresh and wait for the rendered list + persisted file to
  // reflect the stub catalog exactly.
  await settingsPage.clickRefreshModels("Codex");
  await expect(settingsPage.modelList("codex")).toBeVisible();
  // The stub offers two models; assert exact count + ids so a regression
  // in either the click path or the probe would fail the test rather than
  // passing on a partial match.
  await expect(settingsPage.modelListItems("codex")).toHaveCount(2);

  // Poll the persisted JSON until the stub catalog has landed AND the
  // explicit-click timestamp is strictly newer than the boot-refresh one.
  await expect(() => {
    const settings = readSettings() as {
      codingAgents?: {
        id: string;
        cachedModels?: { id: string; name?: string }[];
        cachedModelsUpdatedAt?: number;
      }[];
    };
    const codex = settings.codingAgents?.find((a) => a.id === "codex");
    if (!codex) throw new Error("codex agent not present in settings.json");
    if (codex.cachedModels?.map((m) => m.id).join(",") !== "stub-small,stub-large") {
      throw new Error(
        `expected codex.cachedModels to be the stub catalog, got ${JSON.stringify(codex.cachedModels)}`,
      );
    }
    if (
      typeof codex.cachedModelsUpdatedAt !== "number" ||
      codex.cachedModelsUpdatedAt <= lowerBound
    ) {
      throw new Error(
        `expected cachedModelsUpdatedAt > ${lowerBound}, got ${JSON.stringify(codex.cachedModelsUpdatedAt)}`,
      );
    }
  }).toPass({ timeout: 5_000 });
});

test("changing theme via the dropdown persists the new theme", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("appearance");

  // Open the Theme dropdown and pick Light.
  await settingsPage.selectTheme("Light");

  // Save and verify persistence.
  await settingsPage.save();

  await expect(() => {
    const settings = readSettings();
    if (settings.theme !== "light") {
      throw new Error(`expected theme=light, got ${JSON.stringify(settings.theme)}`);
    }
  }).toPass({ timeout: 5_000 });
});
