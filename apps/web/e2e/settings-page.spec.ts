import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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

// Stub Codex catalog the boot refresh + explicit Refresh click both
// resolve to. Two entries so the test can pin a count and a couple of
// ids without depending on whatever the host's real `codex debug models`
// would return.
const STUB_CODEX_MODELS = [
  { slug: "stub-codex-1", display_name: "Stub Codex 1", priority: 1 },
  { slug: "stub-codex-2", display_name: "Stub Codex 2", priority: 2 },
];

/**
 * Write a stub Codex shell that prints the JSON the adapter expects
 * (`{ "models": [...] }`) when invoked as `<stub> debug models`. The
 * adapter's `refreshModels()` shells out to that exact subcommand
 * (see `packages/coding-agent/src/adapters/codex.ts`), so this stub
 * makes both the boot refresh and the explicit Refresh click
 * deterministic on every CI host without requiring a real codex install.
 */
function writeStubCodex(tmpHome: string): string {
  const binPath = join(tmpHome, "stub-codex.sh");
  const json = JSON.stringify({ models: STUB_CODEX_MODELS });
  writeFileSync(
    binPath,
    `#!/bin/sh\nif [ "$1" = "debug" ] && [ "$2" = "models" ]; then\n  printf '%s\\n' '${json}'\nfi\n`,
    "utf-8",
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { projects: [] });
  const stubCodex = writeStubCodex(tmpHome);
  // Seed codingAgents explicitly so the Default-agent dropdown renders
  // deterministically — without this, runFirstTimeSetup() relies on the
  // host having `claude`/`codex`/`opencode` on PATH, which is true on
  // dev machines but not on CI runners. Point Codex at the stub so the
  // boot refresh + explicit Refresh resolve to a known model list with
  // no host dependency.
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    theme: "dark",
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex", command: stubCodex },
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

test("clicking Refresh models persists the stub catalog to settings.json", async ({ page }) => {
  // User-observable affordance from the refresh-agent-models change:
  // expanding an agent's accordion in the Settings dialog renders a
  // "Refresh" button + per-agent model list. Clicking the button must
  // (a) populate the model list in the DOM with the agent's catalog
  // and (b) write `cachedModels` + `cachedModelsUpdatedAt` into
  // ~/.band/settings.json for that agent.
  //
  // The `beforeAll` above seeded Codex with a stub shell that prints
  // `{ "models": [...] }` — the same shape the real codex binary
  // produces — so the round-trip is fully deterministic on every CI
  // host without a real codex install.

  // Record the pre-click `cachedModelsUpdatedAt` value populated by
  // the boot-time refresh; the assertion below requires the explicit
  // click to bump it strictly forward, so a no-op click would fail
  // the test rather than passing on the boot-refresh value alone.
  const beforeTs = (
    readSettings() as {
      codingAgents?: { id: string; cachedModelsUpdatedAt?: number }[];
    }
  ).codingAgents?.find((a) => a.id === "codex")?.cachedModelsUpdatedAt;
  // Date.now() granularity is 1 ms; tiny sleep so a sub-ms click
  // produces a strictly larger value.
  await new Promise((r) => setTimeout(r, 5));

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  // Open the Codex accordion so the model list + Refresh button mount.
  await settingsPage.expandAgentAccordion("Codex");

  // Click Refresh and wait for the rendered list + persisted file to
  // reflect the stub catalog exactly.
  await settingsPage.clickRefreshModels("Codex");
  await expect(settingsPage.modelList("codex")).toBeVisible();
  // The stub returns two entries; assert exact count + ids so a
  // regression in either the click path or the stub's JSON shape would
  // fail the test rather than passing on a partial match.
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
    if (codex.cachedModels?.map((m) => m.id).join(",") !== "stub-codex-1,stub-codex-2") {
      throw new Error(
        `expected codex.cachedModels to be the stub catalog, got ${JSON.stringify(codex.cachedModels)}`,
      );
    }
    if (
      typeof codex.cachedModelsUpdatedAt !== "number" ||
      codex.cachedModelsUpdatedAt <= (beforeTs ?? 0)
    ) {
      throw new Error(
        `expected cachedModelsUpdatedAt > ${beforeTs ?? 0}, got ${JSON.stringify(codex.cachedModelsUpdatedAt)}`,
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
