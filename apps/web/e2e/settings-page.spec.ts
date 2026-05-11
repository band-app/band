import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";

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
  rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Open the Settings dialog from the dashboard's "Manage" toolbar dropdown.
 * Returns the dialog locator.
 */
async function openSettingsDialog(page: Page) {
  await page.waitForLoadState("networkidle");
  // The "Manage" trigger is the first dropdown trigger rendered in the
  // dashboard toolbar (it opens a menu containing the "Settings" item).
  const trigger = page.locator('[aria-haspopup="menu"]').first();
  await expect(async () => {
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await page.getByRole("menuitem", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpHome, ".band", "settings.json"), "utf-8"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("settings dialog renders every section in a single scrolling list", async ({ page }) => {
  await page.goto(`${server.url}/?token=${TOKEN}`);
  const dialog = await openSettingsDialog(page);

  // Every section is now rendered at once — there is no master/detail
  // navigation. We expect seven SettingsSection cards to be present and
  // every section's first row to be visible (after scrolling, if needed).
  // The seven sections are: Appearance, General, Labels, Coding Agents,
  // Notifications, Web Server, Terminal.
  await expect(dialog.locator('[data-slot="settings-section-card"]')).toHaveCount(7);

  // Appearance — Theme dropdown rendered by SettingsRow.
  await expect(dialog.getByText("Theme", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Theme" })).toBeVisible();

  // Subsequent sections live in the same scrolling column. Use scrollIntoView
  // before asserting visibility because the dialog viewport is fixed-height.
  for (const label of [
    "Worktrees folder",
    "Code intelligence (LSP)",
    "No labels yet",
    "Play sound on needs attention",
    "Port",
    "Auto-start tunnel",
    "GPU-accelerated rendering",
  ]) {
    const row = dialog.getByText(label, { exact: true });
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
  }

  // Coding Agents — the agent labels appear in two places (the per-agent
  // row and, when enabled, the default-agent dropdown's selected value),
  // so target the agent's enable switch which is uniquely keyed.
  for (const agent of ["Claude Code", "Codex", "OpenCode"]) {
    const sw = dialog.getByRole("switch", { name: `Enable ${agent}` });
    await sw.scrollIntoViewIfNeeded();
    await expect(sw).toBeVisible();
  }

  // The "Default coding agent" dropdown only renders when at least one
  // agent is enabled. The first-time-setup hook auto-detects installed
  // CLIs in the test environment, so we expect it to be visible.
  const defaultAgentTrigger = dialog.getByRole("combobox", { name: "Default coding agent" });
  await defaultAgentTrigger.scrollIntoViewIfNeeded();
  await expect(defaultAgentTrigger).toBeVisible();
});

test("toggling LSP and saving persists to settings.json", async ({ page }) => {
  await page.goto(`${server.url}/?token=${TOKEN}`);
  const dialog = await openSettingsDialog(page);

  // No sidebar — the LSP switch is in the General section, somewhere down
  // the scrolling column. Scroll to it before clicking.
  const lspSwitch = dialog.locator("#enable-lsp");
  await lspSwitch.scrollIntoViewIfNeeded();
  await expect(lspSwitch).toBeVisible();
  await expect(lspSwitch).toHaveAttribute("data-state", "unchecked");

  await lspSwitch.click();
  await expect(lspSwitch).toHaveAttribute("data-state", "checked");

  // Save (the icon button in the page header).
  await dialog.getByRole("button", { name: "Save" }).click();

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

  await page.goto(`${server.url}/?token=${TOKEN}`);
  const dialog = await openSettingsDialog(page);

  // The Coding Agents section is part of the single scrolling list. Scroll
  // to Claude Code's enable switch (the per-agent row label and the
  // default-agent dropdown both contain the text "Claude Code", so use
  // the uniquely-named switch instead).
  const claudeSwitch = dialog.getByRole("switch", { name: "Enable Claude Code" });
  await claudeSwitch.scrollIntoViewIfNeeded();
  await expect(claudeSwitch).toBeVisible();

  // Toggle Claude Code so listModels() is called and the model Select
  // potentially mounts. The toggle alone is enough to exercise the
  // listModels effect — saving would close the dialog.
  await claudeSwitch.click({ force: true });

  // Allow listModels() + any subsequent renders to settle.
  await page.waitForTimeout(500);

  // The dialog must still be visible — if Radix had thrown, the React tree
  // would have unmounted into an error boundary.
  await expect(claudeSwitch).toBeVisible();
  expect(errors).toEqual([]);
});

test("changing theme via the dropdown persists the new theme", async ({ page }) => {
  await page.goto(`${server.url}/?token=${TOKEN}`);
  const dialog = await openSettingsDialog(page);

  // Open the Theme dropdown and pick Light.
  const trigger = dialog.getByRole("combobox", { name: "Theme" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole("option", { name: "Light" }).click();
  await expect(trigger).toContainText("Light");

  // Save and verify persistence.
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(() => {
    const settings = readSettings();
    if (settings.theme !== "light") {
      throw new Error(`expected theme=light, got ${JSON.stringify(settings.theme)}`);
    }
  }).toPass({ timeout: 5_000 });
});
