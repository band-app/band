/**
 * Page object for the dashboard's Settings dialog.
 *
 * Owns the locators for the Settings button in the project-list bottom
 * action bar, the dialog itself, and every per-row control we exercise in
 * `e2e/settings-page.spec.ts`. Test bodies never call `page.goto()`,
 * `page.locator()`, `getByText`, or CSS-id selectors directly — they go
 * through this class.
 *
 * Locator priority for elements this app owns:
 *   1. `getByRole({ name })` when the ARIA name is system-controlled.
 *   2. `getByTestId("page__element")` (BEM convention) as a fallback.
 *
 * Every Settings row's control has either an explicit `aria-label` or an
 * associated `<label htmlFor>` that contributes the accessible name, so
 * `getByRole(..., { name })` is the preferred shape here. The Settings
 * gear button in the bottom action bar is anchored via its `data-testid`
 * (`project-list__settings-button`, set in `DashboardShell.tsx`).
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
import { AGENT_MODE_KEY } from "@/dashboard";

export class SettingsPage {
  /** The dialog itself — only visible after `openDialog()`. */
  readonly dialog: Locator;
  /** Save button in the dialog footer. Disabled until something is dirty. */
  readonly saveButton: Locator;
  /** Settings gear icon button in the project-list bottom action bar.
   *  Anchored via `data-testid` (set in `DashboardShell.tsx`). Opens the
   *  Settings dialog directly — no intermediate dropdown. */
  readonly settingsButton: Locator;
  /** The dialog footer holding Save; on mobile it sits on the bottom screen
   *  edge. `data-testid` set in `SettingsPage.tsx`. */
  readonly footer: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByRole("dialog", { name: "Settings" });
    this.settingsButton = page.getByTestId("project-list__settings-button");
    this.saveButton = this.dialog.getByRole("button", { name: "Save" });
    this.footer = page.getByTestId("settings-page__footer");
  }

  /** Navigate to the dashboard root with the test token. */
  async goto(): Promise<void> {
    await test.step("Open dashboard", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      // The dashboard React app fetches projects via tRPC on mount, so the
      // action bar's React click handlers may not be bound by the time `load`
      // fires. Wait for the network to settle before any subsequent step
      // tries to click the Settings button — without this, the first click on
      // the button can be silently lost in CI (matches the workaround already
      // in `tasks-page.spec.ts:openTasksDialog`).
      await this.page.waitForLoadState("networkidle");
    });
  }

  /**
   * Click the Settings button in the project-list bottom action bar and wait
   * for the dialog to render. The button opens the dialog directly, but a
   * hydration-swallowed first click (see `goto`) can drop the event, so
   * re-click until the dialog is actually visible.
   */
  async openDialog(): Promise<void> {
    await test.step("Open Settings dialog from the bottom action bar", async () => {
      await expect(this.settingsButton).toBeVisible();
      await expect
        .poll(
          async () => {
            if (await this.dialog.isVisible().catch(() => false)) return true;
            await this.settingsButton.click();
            return await this.dialog.isVisible().catch(() => false);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    });
  }

  /** Bounding box of the dialog surface. Used to assert the mobile
   *  bottom-drawer geometry (anchored to the bottom edge, with a top
   *  safe-area gap) versus the desktop centred card. Throws if the dialog
   *  isn't rendered so a caller never silently asserts against `null`. */
  async dialogBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    // Wait for the open/slide animation to finish so the measured box is the
    // settled position, not a mid-animation frame.
    await this.dialog.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))),
    );
    const box = await this.dialog.boundingBox();
    if (!box) throw new Error("Settings dialog has no bounding box (not visible)");
    return box;
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

  /** "Translucent sidebar" toggle. Only rendered in the macOS desktop app
   *  (`capabilities.translucentSidebar`); kept as a locator so browser-build
   *  specs can assert its absence. */
  translucentSidebarSwitch(): Locator {
    return this.dialog.getByRole("switch", { name: "Translucent sidebar" });
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

  /** The retired "Cached workspaces" number input. Kept as a locator only so
   *  a test can prove the row no longer renders. */
  cachedWorkspacesInput(): Locator {
    return this.dialog.getByRole("spinbutton", { name: "Cached workspaces" });
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

  /** "Restart terminal service" button in the Terminal section. */
  restartTerminalServiceButton(): Locator {
    return this.dialog.getByRole("button", { name: "Restart terminal service" });
  }

  /** The confirm dialog opened by {@link restartTerminalServiceButton}. */
  restartTerminalServiceDialog(): Locator {
    return this.page.getByRole("dialog", { name: "Restart the terminal service?" });
  }

  /**
   * Click "Restart terminal service", confirm the dialog, and wait for it to
   * close (the mutation settling, per `SettingsPage.tsx`'s `onSettled`).
   */
  async restartTerminalService(): Promise<void> {
    await test.step("Restart the terminal service from Settings", async () => {
      await this.restartTerminalServiceButton().click();
      const dialog = this.restartTerminalServiceDialog();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Restart" }).click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });
    });
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
   *  locator directly. Assertions on the resulting
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

  /** The open list of a select (Radix renders it as a `listbox` in a
   *  portal, outside the dialog). */
  get openSelectList(): Locator {
    return this.page.getByRole("listbox");
  }

  /** An option in the open select list, by its name (agent labels are test
   *  data). Not an exact match: an agent option's name starts with its icon's
   *  title ("Claude Agent 01"). */
  selectOption(name: string): Locator {
    return this.openSelectList.getByRole("option", { name });
  }

  /** Scroll the Default agent select into view inside the dialog and open
   *  it. */
  async openDefaultAgentSelect(): Promise<void> {
    await test.step("Open the Default agent select", async () => {
      const trigger = this.defaultAgentSelect();
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await expect(this.openSelectList).toBeVisible();
    });
  }

  /** Move focus to the last option of the open select with End. */
  async focusLastSelectOption(): Promise<void> {
    await test.step("Focus the last option with the keyboard", async () => {
      await this.page.keyboard.press("End");
    });
  }

  /** Scroll the open select list back to its top. The scroll box is Radix's
   *  viewport element inside the listbox. */
  async scrollSelectListToTop(): Promise<void> {
    await test.step("Scroll the select list to the top", async () => {
      await this.openSelectList.evaluate((el) => {
        const viewport = el.querySelector("[data-radix-select-viewport]");
        if (!viewport) throw new Error("select list has no viewport");
        viewport.scrollTop = 0;
      });
    });
  }

  /** Click an option in the open select list. The list closes. */
  async clickSelectOption(name: string): Promise<void> {
    await test.step(`Click option "${name}"`, async () => {
      await this.selectOption(name).click();
      await expect(this.openSelectList).toBeHidden();
    });
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
   * raw CSS tag selector. Returns the Playwright `Locator`
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
      // Provide the synchronisation guarantee here rather than relying on
      // the next call's implicit wait: under CI scheduler contention the
      // Radix accordion open animation can delay the Refresh button's
      // attachment, so wait for it explicitly before returning.
      await expect(this.refreshModelsButton(agentLabel)).toBeVisible();
    });
  }

  /**
   * Scroll the "Refresh" button for the named agent into view and click
   * it. Mirrors the shape of the other action methods (`toggleLsp`,
   * `selectTheme`) so the test body stays free of raw locator actions.
   */
  async clickRefreshModels(agentLabel: string): Promise<void> {
    await test.step(`Click Refresh models for ${agentLabel}`, async () => {
      const btn = this.refreshModelsButton(agentLabel);
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
    });
  }

  /** One row per host in the Hosts section, the local one included.
   *  `data-testid` set in `HostsSettings.tsx`. */
  hostRows(): Locator {
    return this.dialog.getByTestId("settings__host");
  }

  /** The row of one host by id, matched on the id the row prints. */
  hostRow(hostId: string): Locator {
    return this.hostRows().filter({
      has: this.page.getByTestId("settings__host-id").getByText(hostId, { exact: true }),
    });
  }

  /** The agents line of a host row. `data-testid` set in `HostsSettings.tsx`. */
  hostAgents(hostId: string): Locator {
    return this.hostRow(hostId).getByTestId("settings__host-agents");
  }

  /** The roots line of a host row. */
  hostRoots(hostId: string): Locator {
    return this.hostRow(hostId).getByTestId("settings__host-roots");
  }

  /** Clicks Remove on a host row. */
  async removeHost(hostId: string): Promise<void> {
    await test.step(`Remove host ${hostId}`, async () => {
      await this.hostRow(hostId).getByTestId("settings__host-remove").click();
    });
  }

  /** The Remove button of a host row. */
  hostRemoveButton(hostId: string): Locator {
    return this.hostRow(hostId).getByTestId("settings__host-remove");
  }

  /** One row per token in the Hosts section's Tokens list. */
  tokenRows(): Locator {
    return this.dialog.getByTestId("settings__token");
  }

  /** The notice shown instead of the token list when the token isn't an admin one. */
  tokensDenied(): Locator {
    return this.dialog.getByTestId("settings__tokens-denied");
  }

  /** The row of the token with this label. */
  tokenRow(label: string): Locator {
    return this.tokenRows().filter({ hasText: label });
  }

  /** One row per configured runner. `data-testid` set in `RunnersSettings.tsx`. */
  runnerRow(runnerId: string): Locator {
    return this.dialog.getByTestId("settings__runner").filter({
      has: this.page.getByTestId("settings__runner-id").getByText(runnerId, { exact: true }),
    });
  }

  /** The count of runs in flight on a runner's row. */
  runnerRunning(runner: Locator): Locator {
    return runner.getByTestId("settings__runner-running");
  }

  /** The row of a request a runner took, matched on its workspace id. */
  runnerRun(workspaceId: string): Locator {
    return this.dialog.getByTestId("settings__runner-run").filter({
      has: this.page
        .getByTestId("settings__runner-run-workspace")
        .getByText(workspaceId, { exact: true }),
    });
  }

  /** Opens or closes the log under a run. */
  async toggleRunnerLog(workspaceId: string): Promise<void> {
    await test.step(`Toggle the runner log of ${workspaceId}`, async () => {
      await this.runnerRun(workspaceId).getByTestId("settings__runner-run-log-toggle").click();
    });
  }

  /** The log text under an open run. */
  runnerLog(workspaceId: string): Locator {
    return this.runnerRun(workspaceId).getByTestId("settings__runner-log");
  }

  /** The rows of the machines a runner started. `data-testid` set in `RunnersSettings.tsx`. */
  runnerMachines(runnerId: string): Locator {
    return this.dialog.getByTestId("settings__machine").filter({ hasText: runnerId });
  }

  /** The state of a machine row (`spawning`, `running`, `destroyed`, ...). */
  machineState(machine: Locator): Locator {
    return machine.getByTestId("settings__machine-state");
  }

  /** Clicks Destroy on a machine row. */
  async destroyMachine(machine: Locator): Promise<void> {
    await test.step("Destroy the machine", async () => {
      await machine.getByTestId("settings__machine-destroy").click();
    });
  }

  /** The "Add worker" button in the Hosts section, before the form opens. */
  addWorkerButton(): Locator {
    return this.dialog.getByTestId("settings__add-worker");
  }

  /** Fills the add-worker form and creates the bootstrap token. */
  async addWorker(hostName: string, labels: string): Promise<void> {
    await test.step(`Add worker "${hostName}"`, async () => {
      await this.expectRowVisible(this.addWorkerButton());
      await this.addWorkerButton().click();
      await this.dialog.getByRole("textbox", { name: "Host name" }).fill(hostName);
      await this.dialog.getByRole("textbox", { name: "Labels" }).fill(labels);
      await this.dialog.getByRole("button", { name: "Create token" }).click();
    });
  }

  /** The one-time token shown after "Create token". */
  bootstrapToken(): Locator {
    return this.dialog.getByTestId("settings__bootstrap-token");
  }

  /** The `band-worker` command line shown after "Create token". */
  workerCommand(): Locator {
    return this.dialog.getByTestId("settings__worker-command");
  }

  /** The bootstrap token's text. */
  async readBootstrapToken(): Promise<string> {
    return this.bootstrapToken().inputValue();
  }

  /** The `band-worker` command line's text. */
  async readWorkerCommand(): Promise<string> {
    return this.workerCommand().inputValue();
  }

  /** Closes the add-worker result panel. */
  async finishAddWorker(): Promise<void> {
    await this.dialog.getByRole("button", { name: "Done" }).click();
  }

  /** Clicks Revoke on the token row with this label. */
  async revokeToken(label: string): Promise<void> {
    await test.step(`Revoke token "${label}"`, async () => {
      await this.revokeTokenButton(label).click();
    });
  }

  /** Revoke button of a token row. `aria-label="Revoke token <label>"` is set in `HostsSettings.tsx`. */
  revokeTokenButton(label: string): Locator {
    return this.dialog.getByRole("button", { name: `Revoke token ${label}` });
  }

  /** One row per Band browser profile in the Browser section (the built-in
   *  Default row is not included). `data-testid` set in
   *  `BrowserProfilesSettings.tsx`. */
  browserProfileRows(): Locator {
    return this.dialog.getByTestId("settings__browser-profile");
  }

  /** Trash button of a browser profile row. `aria-label="Delete browser
   *  profile <name>"` is set explicitly in `BrowserProfilesSettings.tsx`. */
  deleteBrowserProfileButton(profileName: string): Locator {
    return this.dialog.getByRole("button", { name: `Delete browser profile ${profileName}` });
  }

  /** Trigger of the "Project defaults" accordion in the Browser section,
   *  collapsed by default. `data-testid` set in `BrowserProfilesSettings.tsx`. */
  projectDefaultsTrigger(): Locator {
    return this.dialog.getByTestId("settings__project-defaults-trigger");
  }

  /** One row per project inside the "Project defaults" accordion.
   *  `data-testid` set in `BrowserProfilesSettings.tsx`. */
  projectBrowserProfileRows(): Locator {
    return this.dialog.getByTestId("settings__project-browser-profile");
  }

  /** Per-project default profile dropdown, inside the "Project defaults"
   *  accordion. `aria-label="Browser profile for <project name>"` is set
   *  explicitly in `BrowserProfilesSettings.tsx`. Tests assert its shown
   *  value by option name ("Default" or a seeded profile name), under the
   *  same carve-out as the theme names above: "Default" is the fixed name
   *  of the built-in profile, not product copy. */
  projectBrowserProfileSelect(projectName: string): Locator {
    return this.dialog.getByRole("combobox", { name: `Browser profile for ${projectName}` });
  }

  /** Open the "Project defaults" accordion and wait for its rows to show. */
  async expandProjectDefaults(): Promise<void> {
    await test.step("Expand Project defaults", async () => {
      const trigger = this.projectDefaultsTrigger();
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(this.projectBrowserProfileRows().first()).toBeVisible();
    });
  }

  /** Pick a project's default browser profile. Applies immediately. The
   *  "Project defaults" accordion must be expanded first. */
  async selectProjectBrowserProfile(projectName: string, profileName: string): Promise<void> {
    await test.step(`Set ${projectName}'s browser profile to "${profileName}"`, async () => {
      const trigger = this.projectBrowserProfileSelect(projectName);
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await this.page.getByRole("option", { name: profileName }).click();
      await expect(trigger).toContainText(profileName);
    });
  }

  /** Click a browser profile row's trash button. */
  async deleteBrowserProfile(profileName: string): Promise<void> {
    await test.step(`Delete browser profile "${profileName}"`, async () => {
      const button = this.deleteBrowserProfileButton(profileName);
      await button.scrollIntoViewIfNeeded();
      await button.click();
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

  /** Pick this browser's agent mode ("Open agents on this device as"). It
   *  saves straight to localStorage, with no Save click. */
  async selectDeviceAgentMode(mode: "gui" | "tui"): Promise<void> {
    await test.step(`Set this device's agent mode to ${mode}`, async () => {
      const trigger = this.dialog.getByTestId("settings-page__device-agent-mode");
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await this.page.getByTestId(`settings-page__agent-mode-option--${mode}`).click();
    });
  }

  /** This browser's saved agent mode, or null. */
  async readDeviceAgentMode(): Promise<string | null> {
    return await this.page.evaluate((key) => localStorage.getItem(key), AGENT_MODE_KEY);
  }

  /** Pick the server's default agent mode ("Open agents started without a
   *  device as"). Takes effect on Save. */
  async selectDefaultAgentMode(mode: "gui" | "tui"): Promise<void> {
    await test.step(`Set the default agent mode to ${mode}`, async () => {
      const trigger = this.dialog.getByTestId("settings-page__default-agent-mode");
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await this.page.getByTestId(`settings-page__default-agent-mode-option--${mode}`).click();
    });
  }

  /** Trigger of a project's entry in the Environment section, collapsed by
   *  default. `data-testid` set in `EnvironmentSettings.tsx`. */
  environmentTrigger(projectName: string): Locator {
    return this.dialog.getByTestId(`settings__environment-trigger-${projectName}`);
  }

  /** Open a project's entry in the Environment section. */
  async expandEnvironment(projectName: string): Promise<void> {
    await test.step(`Expand ${projectName}'s environment`, async () => {
      const trigger = this.environmentTrigger(projectName);
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
    });
  }

  /** The list of validation problems of the open environment. `data-testid`
   *  set in `EnvironmentSettings.tsx`. */
  environmentIssues(): Locator {
    return this.dialog.getByTestId("settings__environment-issues");
  }

  /** Shown instead of the issues when the open environment is valid. */
  environmentValid(): Locator {
    return this.dialog.getByTestId("settings__environment-valid");
  }

  /** Shown when the open project has no `.band/environment.json`. */
  environmentNone(): Locator {
    return this.dialog.getByTestId("settings__environment-none");
  }

  /** The parsed fields of the open environment. */
  environmentSummary(): Locator {
    return this.dialog.getByTestId("settings__environment-summary");
  }

  /** One row per host in the open environment's host check. `data-meets`
   *  is `true` or `false`. */
  environmentHosts(): Locator {
    return this.dialog.getByTestId("settings__environment-host");
  }

  /** The image section of the open environment. `data-testid` set in
   *  `EnvironmentSettings.tsx`. Present only when the file has a `build`. */
  environmentImage(): Locator {
    return this.dialog.getByTestId("settings__environment-image");
  }

  /** Click "Build image" in the open environment, and wait for the build to finish. */
  async buildEnvironmentImage(): Promise<void> {
    await test.step("Build the environment image", async () => {
      const button = this.dialog.getByTestId("settings__environment-image-build");
      await button.click();
      await expect(button).toBeEnabled({ timeout: 30_000 });
      await expect(this.environmentImage()).not.toHaveAttribute("data-status", "building");
    });
  }

  /** The log of the latest image build. */
  environmentImageLog(): Locator {
    return this.dialog.getByTestId("settings__environment-image-log");
  }

  /** An error from starting an image build. */
  environmentImageError(): Locator {
    return this.dialog.getByTestId("settings__environment-image-error");
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
