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

test("settings dialog renders the section list with the new card primitives", async ({ page }) => {
  await page.goto(`${server.url}/?token=${TOKEN}`);
  const dialog = await openSettingsDialog(page);

  // Default open section on lg+ screens is Appearance — the segmented control
  // should be rendered by the new SettingsRow primitive.
  await expect(dialog.getByText("Theme", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("radiogroup", { name: "Theme" })).toBeVisible();

  // The card wrapper introduced by SettingsSection.
  await expect(dialog.locator('[data-slot="settings-section-card"]')).toHaveCount(1);

  // Switch to General. Both rows should render.
  await dialog.getByRole("button", { name: /General/ }).click();
  await expect(dialog.getByText("Worktrees folder", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Code intelligence (LSP)", { exact: true })).toBeVisible();
  await expect(dialog.locator('[data-slot="settings-row"]').first()).toBeVisible();

  // Switch to Web Server. Both rows should render.
  await dialog.getByRole("button", { name: /Web Server/ }).click();
  await expect(dialog.getByText("Port", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Auto-start tunnel", { exact: true })).toBeVisible();

  // Switch to Notifications. The toggle row should render.
  await dialog.getByRole("button", { name: /Notifications/ }).click();
  await expect(dialog.getByText("Play sound on needs attention", { exact: true })).toBeVisible();

  // Switch to Coding Agents. All known agents should render.
  await dialog.getByRole("button", { name: /Coding Agents/ }).click();
  await expect(dialog.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Codex", { exact: true })).toBeVisible();
  await expect(dialog.getByText("OpenCode", { exact: true })).toBeVisible();

  // Switch to Labels. Empty state row should render.
  await dialog.getByRole("button", { name: /Labels/ }).click();
  await expect(dialog.getByText("No labels yet", { exact: true })).toBeVisible();
});

test("toggling LSP and saving persists to settings.json", async ({ page }) => {
  await page.goto(`${server.url}/?token=${TOKEN}`);
  const dialog = await openSettingsDialog(page);

  await dialog.getByRole("button", { name: /General/ }).click();

  // Switch is exposed by Radix as a button with role=switch.
  const lspSwitch = dialog.locator("#enable-lsp");
  await expect(lspSwitch).toBeVisible();
  await expect(lspSwitch).toHaveAttribute("data-state", "unchecked");

  await lspSwitch.click();
  await expect(lspSwitch).toHaveAttribute("data-state", "checked");

  // Save (the icon button in the section header).
  await dialog.getByRole("button", { name: "Save" }).click();

  // Wait for the mutation to complete by polling the persisted JSON.
  await expect(() => {
    const settings = readSettings();
    if (settings.enableLSP !== true) {
      throw new Error(`expected enableLSP=true, got ${JSON.stringify(settings.enableLSP)}`);
    }
  }).toPass({ timeout: 5_000 });
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
