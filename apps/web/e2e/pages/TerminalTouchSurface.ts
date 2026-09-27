import { type CDPSession, type Locator, type Page, test } from "@playwright/test";

/** Where a terminal's viewport sits in its buffer, in rows. */
export interface TerminalScrollPosition {
  /** First buffer row on screen. */
  viewportY: number;
  /** `viewportY` when scrolled to the bottom; 0 when there is no scrollback. */
  baseY: number;
}

/**
 * The visible terminal's surface, driven by finger input on a touch device.
 *
 * Touches go through raw CDP `Input.dispatchTouchEvent` so the page receives
 * real touchstart / touchmove / touchend events (the same path
 * `CenterTabStrip.touchSwipe` uses), which reach both Band's touch layer and
 * xterm's own document-level gesture handler.
 */
export class TerminalTouchSurface {
  /** The persistent wrapper the xterm opens into (`terminal-cache.ts`). */
  readonly wrapper: Locator;
  /** xterm's hidden input textarea; focused means taps reach the keyboard. */
  readonly input: Locator;

  constructor(
    private readonly page: Page,
    private readonly workspaceId: string,
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

  /** Drag one finger vertically through the middle of the terminal and lift
   *  it while still moving, so momentum follows. A positive `distance` moves
   *  the finger up, which scrolls toward the bottom of the output. */
  async swipe(distance: number): Promise<void> {
    await test.step(`Swipe the terminal ${distance}px with a finger`, async () => {
      const { x, y } = await this.center();
      const startY = y + distance / 2;
      const steps = 12;
      await this.withCdp(async (cdp) => {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y: startY }],
        });
        for (let i = 1; i <= steps; i++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: startY - (distance * i) / steps }],
          });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      });
    });
  }

  /** Hold one finger still in the middle of the terminal until `whileHeld`
   *  resolves, then lift it. Both touches go through one CDP session, which
   *  is where Chromium tracks the active touch. */
  async longPress(whileHeld: () => Promise<void>): Promise<void> {
    await test.step("Long-press the terminal", async () => {
      const { x, y } = await this.center();
      await this.withCdp(async (cdp) => {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        try {
          await whileHeld();
        } finally {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        }
      });
    });
  }

  /** Whether xterm has a text selection (a long press selects a word). */
  async hasSelection(): Promise<boolean> {
    return await this.page.evaluate((id) => {
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { workspaceId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      for (const entry of cache?.values() ?? []) {
        if (entry.workspaceId !== id) continue;
        const term = entry.getTerminal() as { hasSelection(): boolean } | null;
        return term?.hasSelection() ?? false;
      }
      return false;
    }, this.workspaceId);
  }

  async unfocus(): Promise<void> {
    await test.step("Move focus out of the terminal", async () => {
      await this.input.blur();
    });
  }

  async tap(): Promise<void> {
    await test.step("Tap the terminal", async () => {
      await this.wrapper.tap();
    });
  }

  /** The terminal's scroll position, read through xterm's public buffer API
   *  on the module-level terminal cache (`globalThis.__bandTerminalCache__`).
   *  Assumes one terminal in the workspace; null until xterm has loaded. */
  async readScrollPosition(): Promise<TerminalScrollPosition | null> {
    return await this.page.evaluate((id) => {
      type Term = { buffer: { active: { viewportY: number; baseY: number } } };
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { workspaceId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      for (const entry of cache?.values() ?? []) {
        if (entry.workspaceId !== id) continue;
        const term = entry.getTerminal() as Term | null;
        if (!term) return null;
        const { viewportY, baseY } = term.buffer.active;
        return { viewportY, baseY };
      }
      return null;
    }, this.workspaceId);
  }

  /** The terminal's size in cells. */
  async readSize(): Promise<{ cols: number; rows: number } | null> {
    return await this.page.evaluate((id) => {
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { workspaceId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      for (const entry of cache?.values() ?? []) {
        if (entry.workspaceId !== id) continue;
        const term = entry.getTerminal() as { cols: number; rows: number } | null;
        return term ? { cols: term.cols, rows: term.rows } : null;
      }
      return null;
    }, this.workspaceId);
  }

  private async center(): Promise<{ x: number; y: number }> {
    const box = await this.wrapper.boundingBox();
    if (!box) throw new Error("terminal has no bounding box — not visible");
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }

  private async withCdp(fn: (cdp: CDPSession) => Promise<unknown>): Promise<void> {
    const cdp = await this.page.context().newCDPSession(this.page);
    try {
      await fn(cdp);
    } finally {
      await cdp.detach();
    }
  }
}
