import { execFileSync } from "node:child_process";
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
  // Disable the boot-time fire-and-forget model refresh so the
  // "Refresh models" e2e below is actually load-bearing on the button
  // click — without this, boot would populate `codex.cachedModels` /
  // `cachedModelsUpdatedAt` in settings.json before the test interacts
  // with the dialog and the "after click" assertion would pass even if
  // the click did nothing. The toggle is a boot-orchestrator opt-out
  // wired in start-server.ts; setting it has no effect on the other
  // tests in this file.
  server = await startServer({
    tmpHome,
    env: { BAND_DISABLE_BOOT_MODEL_REFRESH: "1" },
  });
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
  // navigation. We expect nine SettingsSection cards to be present and
  // every section's first row to be visible (after scrolling, if needed).
  // The nine sections are: Appearance, General, Browser, Labels, Coding
  // Agents, Notifications, Web Server, Usage report, Terminal.
  await expect(settingsPage.sectionCards()).toHaveCount(9);

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
  //
  // `SettingsPage.tsx` renders one row per entry in its `KNOWN_AGENTS`
  // constant regardless of what is seeded in `codingAgents`, so OpenCode
  // is visible here even though only `claude-code` and `codex` are in the
  // beforeAll seed above.
  for (const agent of ["Claude Code", "Codex", "OpenCode"]) {
    await settingsPage.expectRowVisible(settingsPage.agentEnableSwitch(agent));
  }

  // The "Default coding agent" dropdown only renders when at least one
  // agent is enabled. We seed Claude Code as an enabled agent in the
  // `beforeAll` above (and set it as the default), so the dropdown renders
  // deterministically regardless of which CLIs are on the test runner's
  // PATH — `ensureDefaultCodingAgents()` in `server/services/setup.ts` returns early
  // when `codingAgents` is non-empty, skipping the `whichBinary()` probe.
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
  // deterministic signal we have without stubbing the listModels
  // response itself — the CI environment ships no agent binaries, so
  // listModels() returns no models and the Default-model dropdown never
  // mounts. Any *synchronous* Radix throw during the re-render would
  // already have hit the `pageerror` listener by the time the data-state
  // attribute flips; the async-throw case (post-listModels render) is
  // genuinely uncovered here and would require an Express stub fronting
  // listModels to surface deterministically.
  await expect(claudeSwitch).toHaveAttribute("data-state", targetState);

  // The dialog must still be visible — if Radix had thrown, the React tree
  // would have unmounted into an error boundary.
  await expect(claudeSwitch).toBeVisible();
  expect(errors).toEqual([]);
});

/**
 * Probe whether the `codex` binary is reachable on this host. The
 * "Refresh models" test below clicks a button whose server-side
 * handler shells out to `codex debug models`; without the binary the
 * refresh fails with an error message and no persisted cache. Rather
 * than asserting on the error UI (which would still be a valid test
 * of the failure path but a weaker test of the success path), we
 * skip the spec when the binary isn't installed so CI runners
 * without codex don't go red and dev machines exercise the real
 * round-trip.
 *
 * Uses `which codex` rather than a fixed candidate-path list: codex is
 * commonly installed under a per-Node-version path (nvm/fnm/volta) that
 * doesn't match the test runner's own `process.version`, so a hardcoded
 * `.nvm/versions/node/<version>/bin/codex` probe would skip the test on
 * hosts where codex is genuinely on PATH. `which` resolves exactly what
 * the server's `execFile("codex", …)` will find at runtime.
 */
function codexBinaryReachable(): boolean {
  try {
    execFileSync("which", ["codex"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

test("clicking Refresh models persists the cached list to settings.json", async ({ page }) => {
  // User-observable affordance from the refresh-agent-models change:
  // expanding an agent's accordion in the Settings dialog renders a
  // "Refresh" button + per-agent model list. Clicking the button must
  // (a) populate the model list in the DOM and (b) write
  // `cachedModels` + `cachedModelsUpdatedAt` into ~/.band/settings.json
  // for that agent.
  //
  // We exercise Codex because its `refreshModels()` shells out to
  // `codex debug models` — deterministic on a host that has codex
  // installed (the binary returns a stable JSON catalog), and gated
  // by the `codexBinaryReachable()` probe above so CI hosts without
  // codex on PATH skip the test rather than fail.
  test.skip(!codexBinaryReachable(), "codex binary not installed on this host");

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  // Open the Codex accordion so the model list + Refresh button mount.
  await settingsPage.expandAgentAccordion("Codex");

  // Click Refresh and wait for the cached entries to render in the DOM.
  // The page object's locator anchors on the BEM data-testid.
  await settingsPage.clickRefreshModels("Codex");

  await expect(settingsPage.modelList("codex")).toBeVisible();
  // `codex debug models` returns the live catalog (>=1 entry on every
  // released codex binary); assert >0 so the test isn't brittle if
  // OpenAI ships or retires a model.
  await expect(settingsPage.modelListItems("codex")).not.toHaveCount(0);

  // The mutation is fire-and-forget on the client; poll the persisted
  // JSON until `cachedModelsUpdatedAt` appears for codex.
  await expect(() => {
    const settings = readSettings() as {
      codingAgents?: { id: string; cachedModels?: unknown[]; cachedModelsUpdatedAt?: number }[];
    };
    const codex = settings.codingAgents?.find((a) => a.id === "codex");
    if (!codex?.cachedModels || codex.cachedModels.length === 0) {
      throw new Error(
        `expected codex.cachedModels to be persisted, got ${JSON.stringify(codex?.cachedModels)}`,
      );
    }
    if (typeof codex.cachedModelsUpdatedAt !== "number" || codex.cachedModelsUpdatedAt <= 0) {
      throw new Error(
        `expected codex.cachedModelsUpdatedAt to be a positive number, got ${JSON.stringify(codex.cachedModelsUpdatedAt)}`,
      );
    }
  }).toPass({ timeout: 5_000 });
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
