import type { Page } from "@playwright/test";

/**
 * The page's power state, as the UI sees it: on battery (a Battery Status API stand-in the test
 * flips), and focused or blurred. Reads what the saver mode changes: running infinite animations
 * and whether a terminal's cursor blinks.
 */
export class PowerSaverPage {
  constructor(private readonly page: Page) {}

  /**
   * Replaces `navigator.getBattery` before the app loads. A plain browser has no desktop shell, so the UI
   * takes its battery state from this API. The stand-in is the browser's own API, not an own-route mock.
   */
  async installBattery(initialOnBattery: boolean): Promise<void> {
    await this.page.addInitScript((onBattery) => {
      const battery = Object.assign(new EventTarget(), { charging: !onBattery });
      (window as unknown as { __setOnBattery: (on: boolean) => void }).__setOnBattery = (on) => {
        battery.charging = !on;
        battery.dispatchEvent(new Event("chargingchange"));
      };
      (navigator as unknown as { getBattery: () => Promise<unknown> }).getBattery = () =>
        Promise.resolve(battery);
    }, initialOnBattery);
  }

  async setOnBattery(onBattery: boolean): Promise<void> {
    await this.page.evaluate(
      (on) => (window as unknown as { __setOnBattery: (on: boolean) => void }).__setOnBattery(on),
      onBattery,
    );
  }

  async blur(): Promise<void> {
    await this.page.evaluate(() => window.dispatchEvent(new Event("blur")));
  }

  async focus(): Promise<void> {
    await this.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  }

  /** The `data-power` attribute on `<html>`: "saver" or null. */
  async powerAttribute(): Promise<string | null> {
    return await this.page.evaluate(() => document.documentElement.getAttribute("data-power"));
  }

  /** Names of the animations that run now and never end. */
  async runningInfiniteAnimations(): Promise<string[]> {
    return await this.page.evaluate(() =>
      document
        .getAnimations()
        .filter(
          (a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity,
        )
        .map((a) => (a as CSSAnimation).animationName ?? "unnamed"),
    );
  }

  /** `cursorBlink` of the worktree's terminal; null until xterm has loaded. */
  async terminalCursorBlinks(worktreeId: string): Promise<boolean | null> {
    return await this.page.evaluate((id) => {
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { worktreeId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const entry = [...(cache?.values() ?? [])].find((e) => e.worktreeId === id);
      const term = entry?.getTerminal() as { options: { cursorBlink?: boolean } } | null;
      return term ? term.options.cursorBlink === true : null;
    }, worktreeId);
  }
}
