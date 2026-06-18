/**
 * Page object for the dashboard's Settings dialog.
 *
 * Owns the locators for the toolbar Menu trigger, the dialog itself, and
 * every per-row control we exercise in `e2e/settings-page.spec.ts`. Test
 * bodies never call `page.goto()`, `page.locator()`, `getByText`, or CSS-id
 * selectors directly — they go through this class.
 *
 * Locator priority for elements this app owns:
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
 * CARVE-OUT (locator priority): a strict reading of the doctrine
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
  /** "Settings" menuitem inside the open toolbar dropdown. Promoted to a
   *  named property (rather than inlined in `openDialog`) so the locator
   *  lives alongside every other actionable element this POM owns — every
   *  control elsewhere in this class is exposed the same way. */
  readonly settingsMenuItem: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByRole("dialog", { name: "Settings" });
    this.menuTrigger = page.getByTestId("dashboard__menu-trigger");
    this.saveButton = this.dialog.getByRole("button", { name: "Save" });
    this.settingsMenuItem = page.getByRole("menuitem", { name: "Settings" });
  }

  /** Navigate to the dashboard root with the test token. */
  async goto(): Promise<void> {
    await test.step("Open dashboard", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      // The dashboard React app fetches projects via tRPC on mount, so the
      // toolbar's React click handlers may not be bound by the time `load`
      // fires. Wait for the network to settle before any subsequent step
      // tries to drive the dropdown — without this, the first click on the
      // menu trigger is silently lost in CI (matches the workaround already
      // in `tasks-page.spec.ts:openTasksDialog`).
      await this.page.waitForLoadState("networkidle");
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
   *
   * The bare `getByRole("menu")` locator does not carry an accessible name —
   * Radix's `DropdownMenuContent` portal does not accept an `aria-label`
   * without further plumbing, and on the dashboard root the toolbar menu
   * is the only `role="menu"` element in the DOM until something else
   * opens (the label-filter dropdown is gated on `labels.length > 0` and
   * the test seeds an empty project list). If a second menu is ever added
   * unconditionally to the toolbar, scope this locator via an explicit
   * `aria-label` on the `DropdownMenuContent`.
   */
  async openDialog(): Promise<void> {
    await test.step("Open Settings dialog from toolbar menu", async () => {
      await expect(this.menuTrigger).toBeVisible();
      await expect(async () => {
        await this.menuTrigger.click();
        await expect(this.page.getByRole("menu")).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await this.settingsMenuItem.click();
      await expect(this.dialog).toBeVisible();
    });
  }

  /** Locator for every SettingsSection card in the dialog. Anchored on the
   *  `data-testid="settings__section-card"` attribute set by
   *  `SettingsSection.tsx` (BEM convention). */
  sectionCards(): Locator {
    return this.dialog.getByTestId("settings__section-card");
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

  /** Toggle the enable switch for the named agent. Encapsulates the
   *  raw click (force-clicked because the Radix switch can be partly
   *  occluded by the accordion chrome) so test bodies don't drive the
   *  locator directly (TEST-21). Assertions on the resulting
   *  `data-state` stay in the test. */
  async toggleAgentEnable(agentLabel: string): Promise<void> {
    await test.step(`Toggle ${agentLabel} enable switch`, async () => {
      await this.agentEnableSwitch(agentLabel).click({ force: true });
    });
  }

  /** Default coding agent dropdown trigger (only renders when at least
   *  one agent is enabled). `aria-label="Default coding agent"` is set
   *  explicitly. */
  defaultAgentSelect(): Locator {
    return this.dialog.getByRole("combobox", { name: "Default coding agent" });
  }

  /**
   * "Refresh" button next to the per-agent model list inside the Coding
   * Agents accordion. Anchored via `aria-label="Refresh models for
   * <Agent>"` (system-controlled). The button is rendered only when the
   * accordion is expanded — callers should expand the accordion first
   * via `expandAgentAccordion(agentLabel)`.
   */
  refreshModelsButton(agentLabel: string): Locator {
    return this.dialog.getByRole("button", { name: `Refresh models for ${agentLabel}` });
  }

  /**
   * Locator for the rendered model list (a `<ul>`) inside the per-agent
   * accordion. Anchored via `data-testid="settings-page__model-list-<agentId>"`
   * (BEM convention). Parameter is the agent **id** (not label or type)
   * to match the `data-testid` attribute in `SettingsPage.tsx`. For the
   * built-in agents the id and type happen to coincide
   * (`"claude-code"`, `"codex"`, …).
   */
  modelList(agentId: string): Locator {
    return this.dialog.getByTestId(`settings-page__model-list-${agentId}`);
  }

  /**
   * Locator for each `<li>` row in the per-agent model list — anchored via
   * the `listitem` ARIA role so the test body never reaches in with a
   * raw CSS tag selector (TEST-23). Returns the Playwright `Locator`
   * that resolves to every row; callers chain `.first()`, `.nth(i)`,
   * or assert on `.count()` directly.
   */
  modelListItems(agentId: string): Locator {
    return this.modelList(agentId).getByRole("listitem");
  }

  /**
   * Click the per-agent accordion header to expand it, which mounts the
   * "Refresh models" button and the model list. The accordion's trigger
   * is the agent's name button — anchored on `aria-label="Toggle advanced
   * settings for <Agent>"` (system-controlled). The accordion has two
   * triggers with that same name (the label region and the chevron); we
   * pick the first one in DOM order.
   */
  async expandAgentAccordion(agentLabel: string): Promise<void> {
    await test.step(`Expand accordion for ${agentLabel}`, async () => {
      const trigger = this.dialog
        .getByRole("button", {
          name: `Toggle advanced settings for ${agentLabel}`,
        })
        .first();
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
    });
  }

  /**
   * Scroll the "Refresh" button for the named agent into view and click
   * it. Mirrors the shape of the other action methods (`toggleLsp`,
   * `selectTheme`) so the test body stays free of raw locator
   * actions (TEST-21-adjacent).
   */
  async clickRefreshModels(agentLabel: string): Promise<void> {
    await test.step(`Click Refresh models for ${agentLabel}`, async () => {
      const btn = this.refreshModelsButton(agentLabel);
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
    });
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
