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
  seedSettings(tmpHome, { tokenSecret: TOKEN, theme: "dark" });
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
  // navigation. We expect six SettingsSection cards to be present and
  // every section's first row to be visible (after scrolling, if needed).
  await expect(dialog.locator('[data-slot="settings-section-card"]')).toHaveCount(6);

  // Appearance — segmented control rendered by SettingsRow.
  await expect(dialog.getByText("Theme", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("radiogroup", { name: "Theme" })).toBeVisible();

  // Subsequent sections live in the same scrolling column. Use scrollIntoView
  // before asserting visibility because the dialog viewport is fixed-height.
  for (const label of [
    "Worktrees folder",
    "Code intelligence (LSP)",
    "No labels yet",
    "Claude Code",
    "Codex",
    "OpenCode",
    "Play sound on needs attention",
    "Port",
    "Auto-start tunnel",
  ]) {
    const row = dialog.getByText(label, { exact: true });
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
  }
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
  // to its first agent row before interacting.
  const claudeRow = dialog.getByText("Claude Code", { exact: true });
  await claudeRow.scrollIntoViewIfNeeded();
  await expect(claudeRow).toBeVisible();

  // Enable Claude Code so listModels() is called and the model Select
  // potentially mounts. Even without models the toggle path must not throw.
  const claudeSwitch = dialog.getByRole("switch", { name: "Enable Claude Code" });
  await expect(claudeSwitch).toBeVisible();
  await claudeSwitch.click({ force: true });

  // Save so the settings persist and React Query reflects the new agent.
  // listModels() is called when codingAgents changes; the Save round-trip
  // exercises that effect end-to-end.
  await dialog.getByRole("button", { name: "Save" }).click();

  // Allow listModels() + any subsequent renders to settle.
  await page.waitForTimeout(500);

  // The dialog must still be visible — if Radix had thrown, the React tree
  // would have unmounted into an error boundary.
  await expect(dialog.getByText("Claude Code", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("changing theme via segmented control persists the new theme", async ({ page }) => {
  await page.goto(`${server.url}/?token=${TOKEN}`);
  const dialog = await openSettingsDialog(page);

  // Appearance is the default section on lg+ screens.
  const radiogroup = dialog.getByRole("radiogroup", { name: "Theme" });
  await expect(radiogroup).toBeVisible();

  // Click the "Light" segment.
  await radiogroup.getByRole("radio", { name: "Light" }).click();
  await expect(radiogroup.getByRole("radio", { name: "Light" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Save and verify persistence.
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(() => {
    const settings = readSettings();
    if (settings.theme !== "light") {
      throw new Error(`expected theme=light, got ${JSON.stringify(settings.theme)}`);
    }
  }).toPass({ timeout: 5_000 });
});
