/**
 * Page object for the Settings > Workers redesign: the table, the update banner, the drawer
 * sections, the remove confirm dialog and the Activity and Tokens tabs. Test ids are set in
 * `HostsSettings.tsx`, `WorkersTable.tsx`, `WorkerDrawer.tsx` and `WorkersActivity.tsx`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { SettingsPage } from "./SettingsPage";

export class WorkersSettingsPage {
  readonly settings: SettingsPage;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.settings = new SettingsPage(page, baseUrl, token);
  }

  async open(): Promise<void> {
    await test.step("Open Settings > Workers", async () => {
      await this.settings.goto();
      await this.settings.openDialog("hosts");
      await expect(this.table()).toBeVisible();
    });
  }

  table(): Locator {
    return this.page.getByTestId("settings__hosts-table");
  }

  rows(): Locator {
    return this.settings.hostRows();
  }

  row(name: string): Locator {
    return this.rows().filter({ hasText: name });
  }

  thisComputerBadge(): Locator {
    return this.page.getByTestId("this-computer__state");
  }

  updatePill(name: string): Locator {
    return this.row(name).getByTestId("settings__host-update-pill");
  }

  bundledUpdateCell(name: string): Locator {
    return this.row(name).getByTestId("settings__host-update-bundled");
  }

  /** The banner that names the workers behind the hub. */
  banner(): Locator {
    return this.page.getByTestId("settings__workers-behind");
  }

  updateAllButton(): Locator {
    return this.banner().getByTestId("update-all__button");
  }

  checkButtons(): Locator {
    return this.page.getByRole("button", { name: "Check for updates" });
  }

  checkedText(): Locator {
    return this.settings.checkUpdatesLast();
  }

  async openDrawer(name: string): Promise<Locator> {
    await test.step(`Open the drawer of ${name}`, async () => {
      await this.settings.closeHostDrawer();
      await this.row(name).getByTestId("settings__host-name").click();
      await expect(this.drawer().getByTestId("settings__host-drawer-name")).toHaveText(name);
    });
    return this.drawer();
  }

  drawer(): Locator {
    return this.settings.hostDrawer();
  }

  section(name: "updates" | "agents-section" | "trust-section" | "details" | "danger"): Locator {
    return this.drawer().getByTestId(`settings__host-${name}`);
  }

  trustHint(): Locator {
    return this.drawer().getByTestId("settings__host-trust-hint");
  }

  removeButton(): Locator {
    return this.drawer().getByTestId("settings__host-remove");
  }

  removeReasonIcon(): Locator {
    return this.drawer().getByTestId("settings__host-remove-reason-icon");
  }

  removeReason(): Locator {
    return this.page.getByTestId("settings__host-remove-reason");
  }

  removeDialog(): Locator {
    return this.settings.hostRemoveDialog();
  }

  removeCancel(): Locator {
    return this.page.getByTestId("settings__host-remove-cancel");
  }

  removeConfirm(): Locator {
    return this.page.getByTestId("settings__host-remove-confirm");
  }

  tab(name: "workers" | "activity" | "tokens"): Locator {
    return this.page.getByTestId(`settings__workers-tab-${name}`);
  }

  auditEmpty(): Locator {
    return this.page.getByTestId("settings__audit-empty");
  }

  auditEntries(): Locator {
    return this.page.getByTestId("settings__audit-entry");
  }

  /** Tab and drawer order in the DOM: Add worker, banner, tabs, table. */
  addWorkerButton(): Locator {
    return this.settings.addWorkerButton();
  }
}
