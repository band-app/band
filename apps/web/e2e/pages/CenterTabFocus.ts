import { type Locator, type Page, test } from "@playwright/test";

/** What holds keyboard focus in the center dockview, by the kind of surface. */
export type FocusedSurface =
  | "terminal"
  | "editor"
  | "markdown-preview"
  | "diff"
  | "chat-composer"
  // Focus is somewhere else: `<body>`, the tab strip, a hidden leaf.
  | `other:${string}`;

/**
 * Keyboard tab cycling in the visible worktree's center dockview
 * (`WorktreeCenterDockview`), and which surface ends up focused.
 *
 * The leaves' focus targets are partly third-party markup: xterm's
 * `.xterm-helper-textarea` and CodeMirror's `.cm-content` (both used the same
 * way by `WorktreePage` and `TerminalSurface`). Band's own elements are found
 * by their `data-testid`.
 */
export class CenterTabFocus {
  constructor(private readonly page: Page) {}

  async pressNextTab(): Promise<void> {
    await test.step("Press Ctrl+Tab", async () => {
      await this.page.keyboard.press("Control+Tab");
    });
  }

  /** The Ctrl+Tab list. */
  switcher(): Locator {
    return this.page.getByTestId("tab-switcher");
  }

  switcherItems(): Locator {
    return this.page.getByTestId("tab-switcher__item");
  }

  /** Titles in the open list, top to bottom. */
  async switcherTitles(): Promise<string[]> {
    return (await this.switcherItems().allInnerTexts()).map((t) => t.trim());
  }

  /** Hold Ctrl and press Tab (or Shift+Tab) once, leaving Ctrl down. */
  async openSwitcher(opts: { shift?: boolean } = {}): Promise<void> {
    await test.step("Hold Ctrl and press Tab", async () => {
      await this.page.keyboard.down("Control");
      await this.page.keyboard.press(opts.shift ? "Shift+Tab" : "Tab");
    });
  }

  /** Another Tab (or Shift+Tab) while Ctrl is held. */
  async pressTabWhileHeld(opts: { shift?: boolean } = {}): Promise<void> {
    await this.page.keyboard.press(opts.shift ? "Shift+Tab" : "Tab");
  }

  async pressEscapeWhileHeld(): Promise<void> {
    await this.page.keyboard.press("Escape");
  }

  async releaseControl(): Promise<void> {
    await test.step("Release Ctrl", async () => {
      await this.page.keyboard.up("Control");
    });
  }

  /** Hold Ctrl, press Tab `presses` times, release: opens the nth most recent tab. */
  async switchToRecent(presses: number): Promise<void> {
    await this.openSwitcher();
    for (let i = 1; i < presses; i++) await this.pressTabWhileHeld();
    await this.releaseControl();
  }

  /** ⌘] / ⌘[ (Ctrl+] / Ctrl+[ off macOS): the next or previous group. */
  async pressCyclePane(direction: "next" | "previous"): Promise<void> {
    await test.step(`Cycle to the ${direction} pane`, async () => {
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await this.page.keyboard.press(`${modifier}+${direction === "next" ? "]" : "["}`);
    });
  }

  async pressPreviousTab(): Promise<void> {
    await test.step("Press Ctrl+Shift+Tab", async () => {
      await this.page.keyboard.press("Control+Shift+Tab");
    });
  }

  /** Put focus on `<body>`, the way a leaf whose content unmounts drops it. */
  async dropFocusToBody(): Promise<void> {
    await test.step("Drop focus to <body>", async () => {
      await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    });
  }

  /**
   * The surface holding focus. It only counts when the focused element is on
   * screen, so a hidden leaf that kept focus reports `other:`.
   */
  async focusedSurface(): Promise<FocusedSurface> {
    return await this.page.evaluate((): FocusedSurface => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "other:body";
      const describe = `other:${el.tagName.toLowerCase()}${
        el.dataset.testid ? `[${el.dataset.testid}]` : ""
      }`;
      if (el.getClientRects().length === 0 && !el.classList.contains("xterm-helper-textarea")) {
        return `${describe}(hidden)` as FocusedSurface;
      }
      const inside = (testid: string) => el.closest(`[data-testid="${testid}"]`) != null;
      if (el.classList.contains("xterm-helper-textarea")) {
        // xterm's textarea is a 0x0 off-canvas element; its terminal must be
        // the visible one.
        return inside("center-term-leaf__visible-true")
          ? "terminal"
          : (`${describe}(hidden terminal)` as FocusedSurface);
      }
      if (el.classList.contains("cm-content") && inside("center-file-leaf__visible-true")) {
        return inside("file-viewer__markdown-preview") ? "markdown-preview" : "editor";
      }
      if (el.dataset.testid === "center-diff-leaf__scroller") return "diff";
      if (el.dataset.testid === "chat__composer" && inside("center-chat-leaf__visible-true")) {
        return "chat-composer";
      }
      return describe as FocusedSurface;
    });
  }
}
