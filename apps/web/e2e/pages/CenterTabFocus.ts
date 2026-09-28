import { type Page, test } from "@playwright/test";

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
 * Keyboard tab cycling in the visible workspace's center dockview
 * (`WorkspaceCenterDockview`), and which surface ends up focused.
 *
 * The leaves' focus targets are partly third-party markup: xterm's
 * `.xterm-helper-textarea` and CodeMirror's `.cm-content` (both used the same
 * way by `WorkspacePage` and `TerminalSurface`). Band's own elements are found
 * by their `data-testid`.
 */
export class CenterTabFocus {
  constructor(private readonly page: Page) {}

  async pressNextTab(): Promise<void> {
    await test.step("Press Ctrl+Tab", async () => {
      await this.page.keyboard.press("Control+Tab");
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
      if (
        el instanceof HTMLTextAreaElement &&
        el.placeholder === "Type a message..." &&
        inside("center-chat-leaf__visible-true")
      ) {
        return "chat-composer";
      }
      return describe as FocusedSurface;
    });
  }
}
