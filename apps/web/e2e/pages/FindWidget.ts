/**
 * Component object for the floating find widget (`SearchBar` with
 * `variant="floating"`) that the terminal, file editor, markdown preview and
 * diff panes open on Cmd/Ctrl+F. Scoped to the pane that owns it, so a spec
 * can assert which pane's widget opened and where it sits inside that pane.
 */

import { expect, type Locator, test } from "@playwright/test";

export interface WidgetPlacement {
  /** Widget top minus pane top, in CSS px. */
  fromTop: number;
  /** Pane right edge minus widget right edge, in CSS px. */
  fromRight: number;
  /** Widget left edge minus the pane's horizontal midpoint, in CSS px.
   *  Positive when the widget sits entirely in the pane's right half. */
  leftOfMidpoint: number;
}

export class FindWidget {
  readonly root: Locator;
  readonly input: Locator;
  readonly count: Locator;
  readonly matchCaseToggle: Locator;
  readonly wholeWordToggle: Locator;
  readonly regexToggle: Locator;
  readonly previousButton: Locator;
  readonly nextButton: Locator;
  readonly closeButton: Locator;

  constructor(private readonly pane: Locator) {
    this.root = pane.getByTestId("find-widget");
    // Accessible name is the pane's placeholder ("Find in file...", "Find in
    // terminal...", ...), set as `aria-label` in `SearchBar.tsx`.
    this.input = this.root.getByRole("textbox", { name: /^Find in/ });
    this.count = this.root.getByTestId("find-widget__count");
    // Button names come from the `title` attributes set in `SearchBar.tsx`.
    this.matchCaseToggle = this.root.getByRole("button", { name: "Match Case" });
    this.wholeWordToggle = this.root.getByRole("button", { name: "Match Whole Word" });
    this.regexToggle = this.root.getByRole("button", { name: "Use Regular Expression" });
    this.previousButton = this.root.getByRole("button", { name: /^Previous match/ });
    this.nextButton = this.root.getByRole("button", { name: /^Next match/ });
    this.closeButton = this.root.getByRole("button", { name: /^Close/ });
  }

  /** Set on the input (`aria-invalid`) once a query has matched nothing. */
  async expectNoResults(): Promise<void> {
    await expect(this.input).toHaveAttribute("aria-invalid", "true");
  }

  async type(query: string): Promise<void> {
    await test.step(`Type "${query}" into the find widget`, async () => {
      await this.input.fill(query);
    });
  }

  async press(key: string): Promise<void> {
    await test.step(`Press ${key} in the find widget`, async () => {
      await this.input.press(key);
    });
  }

  /** Where the widget sits relative to its pane's bounding box. */
  async placement(): Promise<WidgetPlacement> {
    await expect(this.root).toBeVisible();
    const pane = await this.pane.boundingBox();
    const widget = await this.root.boundingBox();
    if (!pane || !widget) throw new Error("find widget or its pane has no bounding box");
    return {
      fromTop: widget.y - pane.y,
      fromRight: pane.x + pane.width - (widget.x + widget.width),
      leftOfMidpoint: widget.x - (pane.x + pane.width / 2),
    };
  }
}

/** Top edge (CSS px) of `locator`'s bounding box. Used to prove the widget is
 *  laid over a pane's content rather than pushing it down. */
export async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no bounding box");
  return box.y;
}
