import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-settings-test-token";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { projects: [] });
  // Seed codingAgents explicitly so the Default-agent dropdown renders
  // deterministically — without this, runFirstTimeSetup() relies on the
  // host having `claude`/`codex`/`opencode` on PATH, which is true on
  // dev machines but not on CI runners.
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    theme: "dark",
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex" },
    ],
    defaultCodingAgent: "claude-code",
  });
  server = await startServer({ tmpHome });
});

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

test("settings dialog renders every section in a single scrolling list", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  // Every section is now rendered at once — there is no master/detail
  // navigation. We expect eight SettingsSection cards to be present and
  // every section's first row to be visible (after scrolling, if needed).
  // The eight sections are: Appearance, General, Browser, Labels, Coding
  // Agents, Notifications, Web Server, Terminal.
  await expect(settingsPage.sectionCards()).toHaveCount(8);

  // Appearance — Theme dropdown rendered by SettingsRow.
  await expect(settingsPage.themeSelect()).toBeVisible();

  // Subsequent sections live in the same scrolling column. Use
  // `expectRowVisible` (scroll-then-assert) because the dialog viewport
  // is fixed-height. Each row is anchored on its control's accessible
  // name; the empty-Labels-state row is anchored on its "Add label"
  // button (the only stable system-controlled name there).
  for (const row of [
    settingsPage.worktreesFolderInput(),
    settingsPage.lspSwitch(),
    settingsPage.webBrowserCdpSwitch(),
    settingsPage.addLabelButton().first(),
    settingsPage.soundOnNeedsAttentionSwitch(),
    settingsPage.webServerPortInput(),
    settingsPage.autoStartTunnelSwitch(),
    settingsPage.webGLTerminalRendererSwitch(),
  ]) {
    await settingsPage.expectRowVisible(row);
  }

  // Coding Agents — the agent labels appear in two places (the per-agent
  // row and, when enabled, the default-agent dropdown's selected value),
  // so target the agent's enable switch which is uniquely keyed.
  for (const agent of ["Claude Code", "Codex", "OpenCode"]) {
    await settingsPage.expectRowVisible(settingsPage.agentEnableSwitch(agent));
  }

  // The "Default coding agent" dropdown only renders when at least one
  // agent is enabled. The first-time-setup hook auto-detects installed
  // CLIs in the test environment, so we expect it to be visible.
  await settingsPage.expectRowVisible(settingsPage.defaultAgentSelect());
});

test("toggling LSP and saving persists to settings.json", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

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
  await settingsPage.openDialog();

  // The Coding Agents section is part of the single scrolling list. Scroll
  // to Claude Code's enable switch (the per-agent row label and the
  // default-agent dropdown both contain the text "Claude Code", so use
  // the uniquely-named switch instead).
  const claudeSwitch = settingsPage.agentEnableSwitch("Claude Code");
  await settingsPage.expectRowVisible(claudeSwitch);

  // Toggle Claude Code so listModels() is called and the model Select
  // potentially mounts. The toggle alone is enough to exercise the
  // listModels effect — saving would close the dialog.
  await claudeSwitch.click({ force: true });

  // Wait for the toggle to take effect at the DOM level. Once the switch
  // reports `data-state="checked"`, React has applied the state update
  // and the `codingAgents`-keyed effect that calls `listModels()` has
  // fired (the auto-retry inside `toHaveAttribute` doubles as a settling
  // window for the SDK-rendered Select). This is the strongest
  // deterministic signal we have without stubbing the listModels
  // response itself — the CI environment ships no agent binaries, so
  // listModels() returns no models and the Default-model dropdown never
  // mounts. Any *synchronous* Radix throw during the re-render would
  // already have hit the `pageerror` listener by the time the data-state
  // attribute flips; the async-throw case (post-listModels render) is
  // genuinely uncovered here and would require an Express stub fronting
  // listModels to surface deterministically.
  await expect(claudeSwitch).toHaveAttribute("data-state", "checked");

  // The dialog must still be visible — if Radix had thrown, the React tree
  // would have unmounted into an error boundary.
  await expect(claudeSwitch).toBeVisible();
  expect(errors).toEqual([]);
});

test("changing theme via the dropdown persists the new theme", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

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
