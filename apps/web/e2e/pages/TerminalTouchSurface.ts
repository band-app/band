import { type CDPSession, test } from "@playwright/test";
import { TerminalSurface } from "./TerminalSurface";

/**
 * The visible terminal's surface, driven by finger input on a touch device.
 *
 * Touches go through raw CDP `Input.dispatchTouchEvent` so the page receives
 * real touchstart / touchmove / touchend events (the same path
 * `CenterTabStrip.touchSwipe` uses), which reach both Band's touch layer and
 * xterm's own document-level gesture handler.
 */
export class TerminalTouchSurface extends TerminalSurface {
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
