/**
 * Page object for Settings > Extensions (`ExtensionsSettings.tsx`). Rows are found by extension id,
 * defaults by selector glob.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import type { SettingsPage } from "./SettingsPage";

export class ExtensionsSettingsPage {
  constructor(
    private readonly page: Page,
    readonly settings: SettingsPage,
  ) {}

  async open(): Promise<void> {
    await this.settings.goto();
    await this.settings.openDialog("extensions");
  }

  private get dialog(): Locator {
    return this.settings.dialog;
  }

  row(id: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__row--${id}`);
  }

  version(id: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__version--${id}`);
  }

  name(id: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__name--${id}`);
  }

  editors(id: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__editors--${id}`);
  }

  source(id: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__source--${id}`);
  }

  officialRow(id: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__official-row--${id}`);
  }

  /** The "Installed" / "Not compatible" text that replaces the button. */
  officialState(id: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__official-state--${id}`);
  }

  officialInstallButton(id: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__official-install--${id}`);
  }

  get catalogUnavailable(): Locator {
    return this.dialog.getByTestId("settings-extensions__catalog-unavailable");
  }

  async installOfficial(id: string): Promise<void> {
    await test.step(`Install official ${id}`, async () => {
      await this.officialInstallButton(id).click();
      await this.confirmOfficial();
    });
  }

  async confirmOfficial(): Promise<void> {
    await this.page.getByTestId("settings-extensions__official-confirm").click();
  }

  get officialWorkerNote(): Locator {
    return this.page.getByTestId("settings-extensions__official-worker-note");
  }

  brokenFolder(folder: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__broken--${folder}`);
  }

  async openLoadError(folder: string): Promise<Locator> {
    await this.dialog.getByTestId(`settings-extensions__load-error--${folder}`).click();
    return this.page.getByTestId(`settings-extensions__load-error--${folder}-text`);
  }

  get urlInput(): Locator {
    return this.dialog.getByTestId("settings-extensions__url");
  }

  get shaInput(): Locator {
    return this.dialog.getByTestId("settings-extensions__sha256");
  }

  get installButton(): Locator {
    return this.dialog.getByTestId("settings-extensions__install");
  }

  get uploadButton(): Locator {
    return this.dialog.getByTestId("settings-extensions__upload");
  }

  get reloadButton(): Locator {
    return this.dialog.getByTestId("settings-extensions__reload");
  }

  removeButton(id: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__remove--${id}`);
  }

  async installFromUrl(url: string, sha256?: string): Promise<void> {
    await test.step(`Install ${url}`, async () => {
      await this.urlInput.fill(url);
      if (sha256 !== undefined) await this.shaInput.fill(sha256);
      await this.installButton.click();
    });
  }

  async upload(file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
    await test.step(`Upload ${file.name}`, async () => {
      await this.dialog.getByTestId("settings-extensions__file").setInputFiles(file);
    });
  }

  async installError(): Promise<Locator> {
    await this.dialog.getByTestId("settings-extensions__install-error").click();
    return this.page.getByTestId("settings-extensions__install-error-text");
  }

  async remove(id: string): Promise<void> {
    await test.step(`Remove ${id}`, async () => {
      await this.removeButton(id).click();
      await this.page.getByTestId("settings-extensions__remove-confirm").click();
    });
  }

  defaultSelect(glob: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__default--${glob}`);
  }

  defaultValue(glob: string): Locator {
    return this.dialog.getByTestId(`settings-extensions__default-value--${glob}`);
  }

  async chooseDefault(glob: string, option: string): Promise<void> {
    await test.step(`Set the default for ${glob} to ${option}`, async () => {
      await this.defaultSelect(glob).click();
      await this.page
        .getByTestId(`settings-extensions__default-option--${glob}--${option}`)
        .click();
    });
  }

  /** `state` is "manifest", "builtin" or an editor ref. */
  async expectDefault(glob: string, state: string): Promise<void> {
    await expect(this.defaultSelect(glob)).toHaveAttribute("data-default", state);
  }
}
