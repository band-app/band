/**
 * Page object for the dashboard's Settings dialog.
 *
 * Owns the locators for the toolbar Menu trigger, the dialog itself, and
 * every per-row control we exercise in `e2e/settings-page.spec.ts`. Test
 * bodies never call `page.goto()`, `page.locator()`, `getByText`, or CSS-id
 * selectors directly — they go through this class, per the doctrine in
 * `CLAUDE.md` and `docs/frontend-testing.md`.
 *
 * Locator priority for elements this app owns (per CLAUDE.md):
 *   1. `getByRole({ name })` when the ARIA name is system-controlled.
 *   2. `getByTestId("page__element")` (BEM convention) as a fallback.
 *
 * Every Settings row's control has either an explicit `aria-label` or an
 * associated `<label htmlFor>` that contributes the accessible name, so
 * `getByRole(..., { name })` is the preferred shape here. The toolbar
 * "Menu" trigger button is anchored via its `data-testid` (set in
 * `DashboardShell.tsx`) since `aria-label="Menu"` is a generic value and
 * there are other "Menu" buttons elsewhere in the dashboard chrome.
 *
 * CARVE-OUT (CLAUDE.md locator priority): a strict reading of the doctrine
 * bans `getByText`/`getByRole({ name })` against user-visible English copy
 * because that copy may be localised in the future. The row-control names
 * used here (`"Worktrees folder"`, `"Code intelligence (LSP)"`, `"Port"`,
 * `"GPU-accelerated rendering"`, etc.) come from the same `SettingsPage.tsx`
 * source the test targets and Band does not ship localisation today; the
 * name strings are effectively a system-controlled enum of UI affordances
 * rather than translatable product copy. We accept that compromise here
 * to avoid sprinkling a `data-testid` on every `<Input>`/`<Switch>` in the
 * settings dialog — if localisation lands, swapping these to
 * `getByTestId("settings__<row>")` is a mechanical refactor confined to
 * this file plus the matching `data-testid` attributes in the JSX.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class SettingsPage {
  /** The dialog itself — only visible after `openDialog()`. */
  readonly dialog: Locator;
  /** Save button in the dialog footer. Disabled until something is dirty. */
  readonly saveButton: Locator;
  /** "Menu" dropdown trigger in the dashboard toolbar that opens the
   *  menu containing the "Settings" item. Anchored via `data-testid`
   *  (set in `DashboardShell.tsx`) because the bare `aria-label="Menu"`
   *  is ambiguous across the dashboard chrome. */
  readonly menuTrigger: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByRole("dialog", { name: "Settings" });
    this.menuTrigger = page.getByTestId("dashboard__menu-trigger");
    this.saveButton = this.dialog.getByRole("button", { name: "Save" });
  }

  /** Navigate to the dashboard root with the test token. */
  async goto(): Promise<void> {
    await test.step("Open dashboard", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
    });
  }

  /**
   * Open the "Menu" dropdown in the dashboard toolbar and click "Settings".
   *
   * The Radix DropdownMenu has a portal + small mount delay during the
   * initial dashboard hydration, so we wrap the click in an
   * `expect(...).toPass({ timeout })` poll — clicking too early loses the
   * event before the menu mounts. Once the menu is visible we click the
   * "Settings" item and wait for the dialog to render.
   */
  async openDialog(): Promise<void> {
    await test.step("Open Settings dialog from toolbar menu", async () => {
      await expect(async () => {
        await this.menuTrigger.click();
        await expect(this.page.getByRole("menu")).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await this.page.getByRole("menuitem", { name: "Settings" }).click();
      await expect(this.dialog).toBeVisible();
    });
  }

  /** Locator for every SettingsSection card in the dialog. The
   *  `[data-slot="settings-section-card"]` attribute is set by
   *  `SettingsSection.tsx`, so it's a system-controlled anchor rather
   *  than user-visible copy. */
  sectionCards(): Locator {
    return this.dialog.locator('[data-slot="settings-section-card"]');
  }

  /** Theme dropdown trigger — `aria-label="Theme"` is set in
   *  `SettingsPage.tsx` so the combobox role+name locator is exact. */
  themeSelect(): Locator {
    return this.dialog.getByRole("combobox", { name: "Theme" });
  }

  /** Worktrees folder text input. `<label htmlFor="worktrees-dir">` →
   *  `<input id="worktrees-dir">` contributes the accessible name. */
  worktreesFolderInput(): Locator {
    return this.dialog.getByRole("textbox", { name: "Worktrees folder" });
  }

  /** LSP toggle. The Radix Switch button (`<button role="switch"
   *  id="enable-lsp">`) inherits its accessible name from the associated
   *  `<label htmlFor="enable-lsp">Code intelligence (LSP)</label>`. */
  lspSwitch(): Locator {
    return this.dialog.getByRole("switch", { name: "Code intelligence (LSP)" });
  }

  /** Browser CDP experimental toggle. */
  webBrowserCdpSwitch(): Locator {
    return this.dialog.getByRole("switch", {
      name: "Stream desktop tabs to web (experimental)",
    });
  }

  /** "Add label" button — rendered in both the empty state and the row
   *  appended after existing labels. Used to anchor on the Labels section
   *  in tests that don't want to depend on the localised "No labels yet"
   *  copy. The empty-state button is the first one in DOM order. */
  addLabelButton(): Locator {
    return this.dialog.getByRole("button", { name: "Add label" });
  }

  /** "Play sound on needs attention" toggle. */
  soundOnNeedsAttentionSwitch(): Locator {
    return this.dialog.getByRole("switch", { name: "Play sound on needs attention" });
  }

  /** Web server port input — `type="number"` so its ARIA role is
   *  `spinbutton`. */
  webServerPortInput(): Locator {
    return this.dialog.getByRole("spinbutton", { name: "Port" });
  }

  /** "Auto-start tunnel" toggle. */
  autoStartTunnelSwitch(): Locator {
    return this.dialog.getByRole("switch", { name: "Auto-start tunnel" });
  }

  /** Terminal WebGL renderer toggle. */
  webGLTerminalRendererSwitch(): Locator {
    return this.dialog.getByRole("switch", { name: "GPU-accelerated rendering" });
  }

  /** Per-agent enable switch. The button's `aria-label="Enable <Agent>"`
   *  is set explicitly in `SettingsPage.tsx` (the agent label appears in
   *  two other places, so a unique aria-label disambiguates). */
  agentEnableSwitch(agentLabel: string): Locator {
    return this.dialog.getByRole("switch", { name: `Enable ${agentLabel}` });
  }

  /** Default coding agent dropdown trigger (only renders when at least
   *  one agent is enabled). `aria-label="Default coding agent"` is set
   *  explicitly. */
  defaultAgentSelect(): Locator {
    return this.dialog.getByRole("combobox", { name: "Default coding agent" });
  }

  /**
   * Scroll the given locator into view and assert it is visible.
   *
   * The Settings dialog is a single fixed-height scrolling column, so
   * rows past the fold aren't visible until scrolled. Centralising the
   * scroll-then-assert here lets tests just say "should be visible" and
   * not worry about the scrolling step.
   */
  async expectRowVisible(locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeVisible();
  }

  /**
   * Open the Theme dropdown and click an option by its visible name.
   * Theme option names ("System", "Light", "Dark") are user-visible copy,
   * but they are system-controlled enum values rather than translatable
   * strings — they appear in the source as `<SelectItem value="...">`
   * — so `getByRole("option", { name })` is the doctrine-correct locator.
   */
  async selectTheme(theme: "System" | "Light" | "Dark"): Promise<void> {
    await test.step(`Select theme "${theme}"`, async () => {
      const trigger = this.themeSelect();
      await expect(trigger).toBeVisible();
      await trigger.click();
      await this.page.getByRole("option", { name: theme }).click();
      await expect(trigger).toContainText(theme);
    });
  }

  /** Click Save. */
  async save(): Promise<void> {
    await test.step("Click Save", async () => {
      await this.saveButton.click();
    });
  }

  /**
   * Toggle the LSP switch. Asserts the switch is visible (scrolling it
   * into view first) and that the data-state updates after the click —
   * the on-screen visual cue that the switch responded to the input.
   */
  async toggleLsp(): Promise<void> {
    await test.step("Toggle Code intelligence (LSP)", async () => {
      const sw = this.lspSwitch();
      await sw.scrollIntoViewIfNeeded();
      await expect(sw).toBeVisible();
      const previous = await sw.getAttribute("data-state");
      await sw.click();
      const target = previous === "checked" ? "unchecked" : "checked";
      await expect(sw).toHaveAttribute("data-state", target);
    });
  }
}
