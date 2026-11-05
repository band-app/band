/**
 * Page object for `/embed/editor`, the full-screen editor the iOS app loads in a web view. Only the
 * editor renders: no sidebar, no tab strip. The hub signs the page in with a `?token=` link.
 */

import { expect, type FrameLocator, type Locator, type Page, test } from "@playwright/test";

export class EmbedEditorPage {
  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async goto(worktreeId: string, path: string, editor: string): Promise<void> {
    await test.step(`Open the embed route for ${path}`, async () => {
      const query = new URLSearchParams({ worktreeId, path, editor, token: this.token });
      await this.page.goto(`${this.baseUrl}/embed/editor?${query}`);
    });
  }

  get root(): Locator {
    return this.page.getByTestId("embed-editor");
  }

  get editor(): Locator {
    return this.page.getByTestId("extension-editor");
  }

  get error(): Locator {
    return this.page.getByTestId("embed-editor__error");
  }

  get saveButton(): Locator {
    return this.page.getByTestId("extension-editor__save");
  }

  get frame(): FrameLocator {
    return this.editor.frameLocator('[data-testid="extension-editor__frame"]');
  }

  get textarea(): Locator {
    return this.frame.getByRole("textbox", { name: "Document text" });
  }

  get layout(): Locator {
    return this.frame.getByTestId("layout");
  }

  /** Whether the shell around pages (sidebar, tab strip) is on the page. */
  get shell(): Locator {
    return this.page.getByTestId("app-shell__main");
  }

  async waitUntilReady(): Promise<void> {
    await expect(this.editor).toHaveAttribute("data-ready", "true");
  }

  async selectText(start: number, end: number): Promise<void> {
    await test.step(`Select characters ${start}-${end}`, async () => {
      await this.textarea.evaluate(
        (el, range) => {
          const area = el as HTMLTextAreaElement;
          area.focus();
          area.setSelectionRange(range.start, range.end);
          area.dispatchEvent(new Event("select", { bubbles: true }));
        },
        { start, end },
      );
    });
  }
}
