import type { Locator, Page } from "@playwright/test";

/** Where a terminal's viewport sits in its buffer, in rows. */
export interface TerminalScrollPosition {
  /** First buffer row on screen. */
  viewportY: number;
  /** `viewportY` when scrolled to the bottom; 0 when there is no scrollback. */
  baseY: number;
}

/** The screen grid of a terminal, in CSS pixels, for aiming the pointer. */
export interface TerminalGrid {
  cols: number;
  rows: number;
  /** `.xterm-screen`'s bounding rect. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Height of one row: `height / rows`. */
  cellHeight: number;
}

/**
 * The visible terminal's surface, shared by the touch and desktop input page
 * objects. xterm state is read through its public API on the module-level
 * terminal cache (`globalThis.__bandTerminalCache__`). Each read repeats the
 * cache lookup because Playwright serializes `page.evaluate` callbacks, so
 * they can't share a helper. The reads assume one terminal in the workspace.
 */
export class TerminalSurface {
  /** The persistent wrapper the xterm opens into (`terminal-cache.ts`). */
  readonly wrapper: Locator;
  /** xterm's hidden input textarea; focused means keys reach the terminal. */
  readonly input: Locator;

  constructor(
    protected readonly page: Page,
    protected readonly workspaceId: string,
  ) {
    // Only the shown workspace has a visible terminal pane; parked wrappers
    // sit outside any pane.
    this.wrapper = page
      .getByTestId(/^term-pane__/)
      .filter({ visible: true })
      .first()
      .getByTestId("terminal-wrapper");
    this.input = this.wrapper.getByRole("textbox", { name: "Terminal input" });
  }

  /** The terminal's scroll position; null until xterm has loaded. */
  async readScrollPosition(): Promise<TerminalScrollPosition | null> {
    return await this.page.evaluate((id) => {
      type Term = { buffer: { active: { viewportY: number; baseY: number } } };
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { workspaceId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const entry = [...(cache?.values() ?? [])].find((e) => e.workspaceId === id);
      const term = entry?.getTerminal() as Term | null;
      if (!term) return null;
      const { viewportY, baseY } = term.buffer.active;
      return { viewportY, baseY };
    }, this.workspaceId);
  }

  /** The terminal's size in cells; null until xterm has loaded. */
  async readSize(): Promise<{ cols: number; rows: number } | null> {
    return await this.page.evaluate((id) => {
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { workspaceId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const entry = [...(cache?.values() ?? [])].find((e) => e.workspaceId === id);
      const term = entry?.getTerminal() as { cols: number; rows: number } | null;
      return term ? { cols: term.cols, rows: term.rows } : null;
    }, this.workspaceId);
  }

  /** Where the terminal's cells are on the page. */
  async readGrid(): Promise<TerminalGrid> {
    const grid = await this.page.evaluate((id) => {
      type Term = { cols: number; rows: number; element?: HTMLElement };
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { workspaceId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const entry = [...(cache?.values() ?? [])].find((e) => e.workspaceId === id);
      const term = entry?.getTerminal() as Term | null;
      const screen = term?.element?.querySelector(".xterm-screen");
      if (!term || !screen) return null;
      const rect = screen.getBoundingClientRect();
      return {
        cols: term.cols,
        rows: term.rows,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        cellHeight: rect.height / term.rows,
      };
    }, this.workspaceId);
    if (!grid) throw new Error("terminal not loaded");
    return grid;
  }

  /** Whether xterm has a text selection. */
  async hasSelection(): Promise<boolean> {
    return await this.page.evaluate((id) => {
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { workspaceId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const entry = [...(cache?.values() ?? [])].find((e) => e.workspaceId === id);
      const term = entry?.getTerminal() as { hasSelection(): boolean } | null;
      return term?.hasSelection() ?? false;
    }, this.workspaceId);
  }
}
