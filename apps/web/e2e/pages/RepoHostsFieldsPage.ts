/**
 * Page object for the "Available on" and "Primary worker" fields (`RepoHostsFields.tsx`) of the
 * Add repo dialog. It is built on the element that contains the fields. A repo's page in Settings
 * > Repos has its own Workers controls (`SettingsPage.ts`).
 */

import { expect, type Locator, test } from "@playwright/test";

export class RepoHostsFieldsPage {
  constructor(private readonly scope: Locator) {}

  private get fields(): Locator {
    return this.scope.getByTestId("repo-hosts");
  }

  allHostsRadio(): Locator {
    return this.fields.getByTestId("repo-hosts__all");
  }

  onlyRadio(): Locator {
    return this.fields.getByTestId("repo-hosts__only");
  }

  hostCheckbox(hostId: string): Locator {
    return this.fields.locator(`[data-testid="repo-hosts__host"][data-host="${hostId}"]`);
  }

  primarySelect(): Locator {
    return this.fields.getByTestId("repo-hosts__primary");
  }

  async expectAllHosts(): Promise<void> {
    await expect(this.allHostsRadio()).toBeChecked();
    await expect(this.primarySelect()).toHaveValue("");
  }

  /** Asserts the repo is limited to exactly these workers, with `primary` as the primary worker. */
  async expectOnly(hostIds: string[], primary: string): Promise<void> {
    await expect(this.onlyRadio()).toBeChecked();
    await expect(this.fields.getByTestId("repo-hosts__host").first()).toBeVisible();
    for (const box of await this.fields.getByTestId("repo-hosts__host").all()) {
      const id = (await box.getAttribute("data-host")) ?? "";
      if (hostIds.includes(id)) await expect(box).toBeChecked();
      else await expect(box).not.toBeChecked();
    }
    await expect(this.primarySelect()).toHaveValue(primary);
  }

  async chooseAllHosts(): Promise<void> {
    await test.step("Make the repo available on all hosts", async () => {
      await this.allHostsRadio().check();
    });
  }

  /** Limits the repo to `hostIds`: switches to Only and sets the checkboxes. */
  async chooseOnly(hostIds: string[]): Promise<void> {
    await test.step(`Limit the repo to ${hostIds.join(", ")}`, async () => {
      await this.onlyRadio().check();
      await expect(this.fields.getByTestId("repo-hosts__host").first()).toBeVisible();
      for (const box of await this.fields.getByTestId("repo-hosts__host").all()) {
        const id = (await box.getAttribute("data-host")) ?? "";
        await box.setChecked(hostIds.includes(id));
      }
    });
  }

  async choosePrimary(hostId: string): Promise<void> {
    await test.step(`Make ${hostId} the primary host`, async () => {
      await this.primarySelect().selectOption(hostId);
    });
  }
}
