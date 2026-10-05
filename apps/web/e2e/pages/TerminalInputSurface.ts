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
   * `WorktreePage.goto` so the listener sees the socket open. Returns a
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

  /** The 1-based screen cell where `text` starts on the last row that
   *  contains it, read from xterm's buffer. */
  private async cellOfText(text: string): Promise<{ col: number; row: number }> {
    const cell = await this.page.evaluate(
      ([id, needle]) => {
        type Line = { translateToString(trim?: boolean): string };
        type Term = {
          buffer: { active: { viewportY: number; getLine(y: number): Line | undefined } };
          rows: number;
        };
        const cache = (
          globalThis as unknown as {
            __bandTerminalCache__?: Map<string, { worktreeId: string; getTerminal(): unknown }>;
          }
        ).__bandTerminalCache__;
        const entry = [...(cache?.values() ?? [])].find((e) => e.worktreeId === id);
        const term = entry?.getTerminal() as Term | null;
        if (!term) return null;
        const { viewportY } = term.buffer.active;
        for (let row = term.rows - 1; row >= 0; row--) {
          const text = term.buffer.active.getLine(viewportY + row)?.translateToString(true) ?? "";
          const col = text.indexOf(needle);
          if (col >= 0) return { col: col + 1, row: row + 1 };
        }
        return null;
      },
      [this.worktreeId, text] as const,
    );
    if (!cell) throw new Error(`"${text}" is not on the terminal screen`);
    return cell;
  }

  /** Double-click the word `text` on the screen, selecting it. */
  async selectWord(text: string): Promise<void> {
    await test.step(`Select "${text}" in the terminal`, async () => {
      const { col, row } = await this.cellOfText(text);
      const { x, y } = await this.cellCenter(col, row);
      await this.page.mouse.dblclick(x, y);
    });
  }

  /** Right-click the word `text` on the screen. */
  async rightClickWord(text: string): Promise<void> {
    await test.step(`Right-click "${text}" in the terminal`, async () => {
      const { col, row } = await this.cellOfText(text);
      const { x, y } = await this.cellCenter(col, row);
      await this.page.mouse.click(x, y, { button: "right" });
    });
  }

  /** Click the first cell of the bottom row, below the prompt, where there is
   *  no text, to drop any selection, then right-click it. */
  async rightClickBlankRow(): Promise<void> {
    await test.step("Right-click an empty terminal row with nothing selected", async () => {
      const { rows } = await this.readGrid();
      const { x, y } = await this.cellCenter(1, rows);
      await this.page.mouse.click(x, y);
      await this.page.mouse.click(x, y, { button: "right" });
    });
  }

  /** The text xterm has selected. */
  async readSelection(): Promise<string> {
    return await this.page.evaluate((id) => {
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { worktreeId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const entry = [...(cache?.values() ?? [])].find((e) => e.worktreeId === id);
      const term = entry?.getTerminal() as { getSelection(): string } | null;
      return term?.getSelection() ?? "";
    }, this.worktreeId);
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
