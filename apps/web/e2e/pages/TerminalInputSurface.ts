import { test } from "@playwright/test";
import { TerminalSurface } from "./TerminalSurface";

/**
 * The visible terminal on a desktop: pointer wheel input, key bursts, and the
 * input messages the page sends on the terminal WebSocket.
 *
 * Wheel input goes through CDP, so the page gets real `wheel` events at the
 * pointer's position from Chromium's input pipeline.
 */
export class TerminalInputSurface extends TerminalSurface {
  /**
   * Record every input message the page sends on a terminal WebSocket: text
   * frames that aren't JSON control messages (`{"type": ...}`). Call before
   * `WorkspacePage.goto` so the listener sees the socket open. Returns a
   * getter for the messages so far.
   */
  trackInputMessages(): () => string[] {
    const messages: string[] = [];
    this.page.on("websocket", (ws) => {
      if (!ws.url().includes("/terminal?")) return;
      ws.on("framesent", ({ payload }) => {
        if (typeof payload !== "string" || payload.startsWith('{"type"')) return;
        messages.push(payload);
      });
    });
    return () => [...messages];
  }

  /** The page position of the middle of the 1-based cell (`col`, `row`). */
  private async cellCenter(col: number, row: number): Promise<{ x: number; y: number }> {
    const grid = await this.readGrid();
    return {
      x: Math.round(grid.left + (col - 0.5) * (grid.width / grid.cols)),
      y: Math.round(grid.top + (row - 0.5) * grid.cellHeight),
    };
  }

  /** Move the pointer to the middle of the 1-based cell (`col`, `row`). */
  async hoverCell(col: number, row: number): Promise<void> {
    await test.step(`Point at terminal cell ${col},${row}`, async () => {
      const { x, y } = await this.cellCenter(col, row);
      await this.page.mouse.move(x, y);
    });
  }

  /** Send `count` mouse wheel notches of `deltaY` pixels at the pointer,
   *  with `modifier` held. Chromium gives these the legacy `wheelDelta` of
   *  ±120 a physical wheel notch has. Positive `deltaY` scrolls toward the
   *  bottom. */
  async wheel(
    deltaY: number,
    count = 1,
    { modifier }: { modifier?: "Shift" | "Control" } = {},
  ): Promise<void> {
    const label = `${modifier ? `${modifier}+` : ""}Wheel ${count} × ${deltaY}px`;
    await test.step(label, async () => {
      if (modifier) await this.page.keyboard.down(modifier);
      try {
        for (let i = 0; i < count; i++) await this.page.mouse.wheel(0, deltaY);
      } finally {
        if (modifier) await this.page.keyboard.up(modifier);
      }
    });
  }

  /**
   * Scroll `distance` pixels at the 1-based cell (`col`, `row`) the way a
   * trackpad does: CDP `Input.synthesizeScrollGesture` with a mouse source
   * sends a stream of small precise pixel deltas (legacy `wheelDelta` about
   * 3 × `deltaY`, as a Mac trackpad gives), with no fling afterwards.
   * Positive `distance` scrolls toward the bottom.
   */
  async trackpadScroll(col: number, row: number, distance: number): Promise<void> {
    await test.step(`Trackpad-scroll ${distance}px at cell ${col},${row}`, async () => {
      const { x, y } = await this.cellCenter(col, row);
      const cdp = await this.page.context().newCDPSession(this.page);
      try {
        await cdp.send("Input.synthesizeScrollGesture", {
          x,
          y,
          yDistance: -distance,
          gestureSourceType: "mouse",
          speed: 800,
        });
      } finally {
        await cdp.detach();
      }
    });
  }

  /**
   * Press each character of `text` while the page's main thread is blocked,
   * so the key events queue up and run back to back once it frees, the way
   * key auto-repeat or a fast typist lands on a page busy repainting.
   *
   * The page spins until the browser reports queued input
   * (`navigator.scheduling.isInputPending`), then a little longer so every
   * key is queued, capped at 5 s.
   */
  async typeWhileBusy(text: string): Promise<void> {
    await test.step(`Type "${text}" while the page is busy`, async () => {
      await this.input.focus();
      const busy = this.page.evaluate(() => {
        const scheduling = (navigator as unknown as { scheduling?: { isInputPending(): boolean } })
          .scheduling;
        const start = performance.now();
        let pendingSince: number | null = null;
        while (performance.now() - start < 5_000) {
          if (pendingSince === null && scheduling?.isInputPending()) {
            pendingSince = performance.now();
          }
          if (pendingSince !== null && performance.now() - pendingSince > 300) return;
        }
      });
      await Promise.all([busy, ...[...text].map((key) => this.page.keyboard.press(key))]);
    });
  }

  /** Press one key into the terminal. */
  async press(key: string): Promise<void> {
    await test.step(`Press ${key}`, async () => {
      await this.input.focus();
      await this.page.keyboard.press(key);
    });
  }
}
