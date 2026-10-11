/**
 * Page object for the Add repo dialog of the sidebar's Repos panel (`AddRepoDialog.tsx`). Test
 * bodies call only the methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { RepoHostsFieldsPage } from "./RepoHostsFieldsPage";

export class AddRepoPage {
  private readonly page: Page;
  private readonly dialog: Locator;
  private readonly form: Locator;
  /** The "Available on" and "Primary host" fields of whichever add mode is showing. */
  readonly hosts: RepoHostsFieldsPage;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId("add-repo__dialog");
    this.form = this.dialog.getByTestId("add-repo__form");
    this.hosts = new RepoHostsFieldsPage(this.form);
  }

  /** Opens Add repo from the sidebar's Repos panel. */
  async open(): Promise<void> {
    await test.step("Open Add repo from the Repos panel", async () => {
      await this.page.getByTestId("repos-panel__add-repo").click();
      await expect(this.form).toBeVisible();
    });
  }

  noHostsNotice(): Locator {
    return this.form.getByTestId("add-repo__no-hosts");
  }

  openHostsButton(): Locator {
    return this.form.getByTestId("add-repo__open-hosts");
  }

  nativePicker(): Locator {
    return this.form.getByTestId("add-repo__pick-native");
  }

  async chooseWorker(hostId: string): Promise<void> {
    await test.step(`Choose worker ${hostId}`, async () => {
      await this.form.getByTestId("add-repo__host").selectOption(hostId);
    });
  }

  pickerEntry(name: string): Locator {
    return this.form.locator(`[data-testid="add-repo__picker-entry"][data-name="${name}"]`);
  }

  pickerPath(): Locator {
    return this.form.getByTestId("add-repo__picker-path");
  }

  crumbs(): Locator {
    return this.form.getByTestId("add-repo__crumb");
  }

  async filter(text: string): Promise<void> {
    await this.form.getByTestId("add-repo__filter").fill(text);
  }

  /** Opens a folder in the picker. */
  async openFolder(name: string): Promise<void> {
    await this.pickerEntry(name).click();
    await expect(this.pickerPath()).toContainText(name);
  }

  /** Picks the open folder, which shows its remote URL and branch before anything is added. */
  async useCurrentFolder(): Promise<void> {
    await this.form.getByTestId("add-repo__picker-select").click();
    await expect(this.form.getByTestId("add-repo__preview")).toBeVisible();
  }

  previewUrl(): Locator {
    return this.form.getByTestId("add-repo__preview-url");
  }

  previewBranch(): Locator {
    return this.form.getByTestId("add-repo__preview-branch");
  }

  previewLocalOnly(): Locator {
    return this.form.getByTestId("add-repo__preview-local-only");
  }

  /** Adds the previewed folder. */
  async confirm(): Promise<void> {
    await test.step("Add the previewed folder", async () => {
      await this.form.getByTestId("add-repo__confirm").click();
    });
  }

  rootConfirmation(): Locator {
    return this.form.getByTestId("add-repo__confirm-root");
  }

  /** Adds the previewed folder that lies outside the worker's roots, adding it as a root. */
  async confirmRoot(): Promise<void> {
    await this.form.getByTestId("add-repo__confirm-root-accept").click();
  }

  async chooseUrl(): Promise<void> {
    await this.form.getByTestId("add-repo__mode-url").click();
  }

  /** Switches to By URL with the button in the no-worker notice. */
  async chooseUrlFromNotice(): Promise<void> {
    await this.form.getByTestId("add-repo__no-hosts-url").click();
  }

  async fillUrl(remoteUrl: string): Promise<void> {
    await this.form.getByTestId("add-repo__url").fill(remoteUrl);
  }

  /** The default branch the hub read from the remote for the typed URL. */
  resolvedBranch(): Locator {
    return this.form.getByTestId("add-repo__url-resolved-branch");
  }

  /** Adds a repo by URL. With no branch, the hub uses the one it resolves from the remote. */
  async addByUrl(remoteUrl: string, defaultBranch?: string): Promise<void> {
    await test.step(`Add ${remoteUrl} by URL`, async () => {
      await this.fillUrl(remoteUrl);
      if (defaultBranch) await this.form.getByTestId("add-repo__branch").fill(defaultBranch);
      await this.form.getByTestId("add-repo__url-submit").click();
    });
  }

  error(): Locator {
    return this.form.getByTestId("add-repo__error");
  }

  /** The dialog itself, to assert that it closed after an add. */
  closed(): Locator {
    return this.dialog;
  }

  /**
   * Horizontal overflow of the page and of the dialog: the document's scroll width against the
   * window, the dialog's own scroll width against its box, and every descendant that sticks out
   * past the dialog box on either side.
   */
  async overflow(): Promise<DialogOverflow> {
    return await measureDialogOverflow(this.dialog);
  }

  /** Writes a screenshot of the dialog. */
  async screenshot(path: string): Promise<void> {
    // "disabled" finishes the tab and dialog transitions first, so the shot shows the settled state.
    await this.dialog.screenshot({ path, animations: "disabled" });
  }

  /** The primary button of the confirm step when the folder lies outside the worker's roots. */
  confirmRootButton(): Locator {
    return this.form.getByTestId("add-repo__confirm-root-accept");
  }

  urlSubmitButton(): Locator {
    return this.form.getByTestId("add-repo__url-submit");
  }

  pickerSelectButton(): Locator {
    return this.form.getByTestId("add-repo__picker-select");
  }
}

export interface DialogOverflow {
  documentScrollWidth: number;
  innerWidth: number;
  dialogScrollWidth: number;
  dialogClientWidth: number;
  /** Test ids (or tag names) of descendants whose box leaves the dialog's box. */
  escaping: string[];
}

/** Measures horizontal overflow around one dialog element. */
export async function measureDialogOverflow(dialog: Locator): Promise<DialogOverflow> {
  return await dialog.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const escaping: string[] = [];
    for (const child of el.querySelectorAll<HTMLElement>("*")) {
      // Content inside a horizontally scrolling container is allowed to be wider than the box.
      let clipped = false;
      for (let p = child.parentElement; p && p !== el; p = p.parentElement) {
        const overflowX = getComputedStyle(p).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      const r = child.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < box.left - 1 || r.right > box.right + 1) {
        escaping.push(child.dataset.testid ?? child.tagName.toLowerCase());
      }
    }
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      dialogScrollWidth: el.scrollWidth,
      dialogClientWidth: el.clientWidth,
      escaping,
    };
  });
}
