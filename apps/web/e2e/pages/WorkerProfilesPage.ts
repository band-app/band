/**
 * Page object for Settings > Workers > Profiles and the profile selector in a worker's drawer.
 * Test ids and labels are set in `WorkerProfilesSettings.tsx` and `WorkerDrawer.tsx`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { SettingsPage } from "./SettingsPage";

export interface ProfileForm {
  name?: string;
  labels?: string;
  trust?: "restricted" | "standard" | "admin";
  env?: string;
  restrictCredentials?: boolean;
  gitCredentials?: string[];
}

export class WorkerProfilesPage {
  readonly settings: SettingsPage;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.settings = new SettingsPage(page, baseUrl, token);
  }

  async open(): Promise<void> {
    await test.step("Open Settings > Workers > Profiles", async () => {
      await this.settings.goto();
      await this.settings.openDialog("hosts");
      await this.page.getByTestId("settings__workers-tab-profiles").click();
      await expect(this.page.getByTestId("settings__profiles")).toBeVisible();
    });
  }

  async showWorkers(): Promise<void> {
    await this.page.getByTestId("settings__workers-tab-workers").click();
  }

  async showProfiles(): Promise<void> {
    await this.page.getByTestId("settings__workers-tab-profiles").click();
  }

  profile(name: string): Locator {
    return this.page
      .getByTestId("settings__profile")
      .and(this.page.locator(`[data-profile-name="${name}"]`));
  }

  async create(form: ProfileForm & { name: string }): Promise<void> {
    await test.step(`Create the profile ${form.name}`, async () => {
      await this.page.getByTestId("settings__profile-new").click();
      await this.fillEditor(form);
      await this.page.getByTestId("settings__profile-save").click();
    });
  }

  async edit(name: string, form: ProfileForm): Promise<void> {
    await test.step(`Edit the profile ${name}`, async () => {
      await this.page.getByRole("button", { name: `Edit profile ${name}` }).click();
      await this.fillEditor(form);
      await this.page.getByTestId("settings__profile-save").click();
    });
  }

  async delete(name: string): Promise<void> {
    await this.page.getByRole("button", { name: `Delete profile ${name}` }).click();
  }

  async fillEditor(form: ProfileForm): Promise<void> {
    if (form.name !== undefined) {
      await this.page.getByRole("textbox", { name: "Profile name" }).fill(form.name);
    }
    if (form.labels !== undefined) {
      await this.page.getByRole("textbox", { name: "Profile labels" }).fill(form.labels);
    }
    if (form.trust) {
      await this.page.getByRole("combobox", { name: "Profile trust" }).selectOption(form.trust);
    }
    if (form.env !== undefined) {
      await this.page.getByRole("textbox", { name: "Profile worker env" }).fill(form.env);
    }
    if (form.restrictCredentials !== undefined) {
      await this.page
        .getByRole("checkbox", { name: "Restrict credentials" })
        .setChecked(form.restrictCredentials);
    }
    for (const item of form.gitCredentials ?? []) {
      await this.page.getByRole("checkbox", { name: `Git credential ${item}` }).check();
    }
  }

  async saveEditor(): Promise<void> {
    await this.page.getByTestId("settings__profile-save").click();
  }

  /** Closes the open error popover. */
  async dismissError(): Promise<void> {
    await this.page.keyboard.press("Escape");
  }

  saveErrorIcon(): Locator {
    return this.page.getByTestId("settings__profile-save-error-icon");
  }

  saveErrorText(): Locator {
    return this.page.getByTestId("settings__profile-save-error");
  }

  deleteErrorIcon(): Locator {
    return this.page.getByTestId("settings__profile-error-icon");
  }

  deleteErrorText(): Locator {
    return this.page.getByTestId("settings__profile-error");
  }

  /** The profile selector in an open worker drawer. */
  workerProfileSelect(workerName: string): Locator {
    return this.page.getByRole("combobox", { name: `Profile of ${workerName}` });
  }

  /** The profile picker in the Add worker dialog. */
  provisionProfileSelect(): Locator {
    return this.settings.addWorkerHubDialog().getByTestId("settings__provision-profile");
  }

  /** Picks a profile in the Add worker dialog and gets the provisioning command. */
  async getProvisioningCommandWith(profile: string): Promise<void> {
    await test.step(`Get a provisioning command with the profile ${profile}`, async () => {
      await this.settings.addWorkerButton().click();
      await this.provisionProfileSelect().selectOption(profile);
      await this.settings.addWorkerHubDialog().getByTestId("settings__provision-create").click();
    });
  }
}
