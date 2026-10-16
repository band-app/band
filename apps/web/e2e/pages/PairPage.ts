import type { Locator, Page } from "@playwright/test";

/** The page a pairing link opens (`/?pair=<code>`), served by the hub before sign-in. */
export class PairPage {
  constructor(private readonly page: Page) {}

  async open(link: string): Promise<void> {
    await this.page.goto(link);
  }

  /** The message under the title. Its `data-state` is `refused` when the link can't be used. */
  message(): Locator {
    return this.page.getByTestId("pair__message");
  }
}
