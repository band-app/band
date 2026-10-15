/**
 * Page object for Settings > Appearance and for reading the theme the page
 * ended up with (CSS variables and computed styles on <html>). Test bodies
 * never touch locators or `page.evaluate` directly.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { SettingsPage } from "./SettingsPage";

export type ColorKey = "accent" | "background" | "foreground";

export class AppearancePage {
  readonly settings: SettingsPage;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.settings = new SettingsPage(page, baseUrl, token);
  }

  async open(): Promise<void> {
    await this.settings.goto();
    await this.settings.openDialog("appearance");
    await expect(this.root).toBeVisible();
  }

  get root(): Locator {
    return this.settings.dialog.getByTestId("appearance");
  }

  modeCard(mode: "system" | "light" | "dark"): Locator {
    return this.root.getByTestId(`appearance__mode-${mode}`);
  }

  presetSelect(): Locator {
    return this.root.getByTestId("appearance__preset");
  }

  colorHex(key: ColorKey): Locator {
    return this.root.getByTestId(`appearance__${key}-hex`);
  }

  colorPicker(key: ColorKey): Locator {
    return this.root.getByTestId(`appearance__${key}-picker`);
  }

  uiFontSelect(): Locator {
    return this.root.getByTestId("appearance__ui-font");
  }

  codeFontSelect(): Locator {
    return this.root.getByTestId("appearance__code-font");
  }

  uiSizeInput(): Locator {
    return this.root.getByTestId("appearance__ui-size");
  }

  codeSizeInput(): Locator {
    return this.root.getByTestId("appearance__code-size");
  }

  resetButton(): Locator {
    return this.root.getByTestId("appearance__reset");
  }

  async chooseMode(mode: "system" | "light" | "dark"): Promise<void> {
    await test.step(`Choose the ${mode} mode`, async () => {
      await this.modeCard(mode).click();
      await expect(this.modeCard(mode)).toHaveAttribute("aria-checked", "true");
    });
  }

  async choosePreset(label: string): Promise<void> {
    await test.step(`Choose the ${label} theme`, async () => {
      await this.presetSelect().click();
      await this.page.getByRole("option", { name: label }).click();
      await expect(this.presetSelect()).toContainText(label);
    });
  }

  async chooseFont(which: "ui" | "code", label: string): Promise<void> {
    await test.step(`Choose the ${which} font ${label}`, async () => {
      const trigger = which === "ui" ? this.uiFontSelect() : this.codeFontSelect();
      await trigger.click();
      await this.page.getByRole("option", { name: label, exact: true }).click();
      await expect(trigger).toContainText(label);
    });
  }

  async setColor(key: ColorKey, hex: string): Promise<void> {
    await test.step(`Set ${key} to ${hex}`, async () => {
      const field = this.colorHex(key);
      await field.fill(hex);
      await field.press("Enter");
      await expect(field).toHaveValue(hex.toUpperCase());
    });
  }

  async setSize(which: "ui" | "code", px: number): Promise<void> {
    await test.step(`Set the ${which} font size to ${px}px`, async () => {
      const field = which === "ui" ? this.uiSizeInput() : this.codeSizeInput();
      await field.fill(String(px));
      await field.press("Enter");
      await expect(field).toHaveValue(String(px));
    });
  }

  async reset(): Promise<void> {
    await test.step("Reset to default", async () => {
      await this.resetButton().click();
    });
  }

  /** A CSS variable as set or computed on <html>, trimmed. */
  async cssVar(name: string): Promise<string> {
    return await this.page.evaluate(
      (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
      name,
    );
  }

  /** The variable as written inline on <html> by the theme runtime ("" when unset). */
  async inlineVar(name: string): Promise<string> {
    return await this.page.evaluate(
      (n) => document.documentElement.style.getPropertyValue(n).trim(),
      name,
    );
  }

  async isDark(): Promise<boolean> {
    return await this.page.evaluate(() => document.documentElement.classList.contains("dark"));
  }

  async rootFontSizePx(): Promise<number> {
    return await this.page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
  }

  /** Computed `property` of the element behind `locator`. */
  async computed(locator: Locator, property: string): Promise<string> {
    return await locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
  }

  /** This browser's copy of the synced appearance (null while nothing was changed). */
  async storedAppearance(): Promise<string | null> {
    return await this.page.evaluate(() => localStorage.getItem("band-appearance"));
  }

  /**
   * Reopens the dialog until the preset field shows `label`. The browser that
   * changed the theme pushes it to the hub after a short delay, so a second
   * browser may need a reload or two before the hub's copy reaches it.
   */
  async openUntilPreset(label: string): Promise<void> {
    await expect
      .poll(
        async () => {
          await this.open();
          return (await this.presetSelect().textContent()) ?? "";
        },
        { timeout: 15_000 },
      )
      .toContain(label);
  }

  /**
   * Reloads the app and returns the `--background` the page first had inline,
   * recorded by an observer that starts before any page script. Only the
   * blocking script in <head> can have set it by then.
   */
  async backgroundAtFirstPaint(): Promise<string> {
    await this.page.addInitScript(() => {
      const w = window as unknown as { __firstBackground?: string };
      // The init script can run before <html> exists, so watch the document.
      new MutationObserver((_records, observer) => {
        const value = document.documentElement?.style.getPropertyValue("--background").trim();
        if (value) {
          w.__firstBackground = value;
          observer.disconnect();
        }
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style"],
      });
    });
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.page.waitForFunction(() =>
      Boolean((window as unknown as { __firstBackground?: string }).__firstBackground),
    );
    return await this.page.evaluate(
      () => (window as unknown as { __firstBackground?: string }).__firstBackground ?? "",
    );
  }

  /** Computed font size of the code editor on screen. */
  async codeEditorFontSize(): Promise<string> {
    const container = this.page.getByTestId("code-editor").first();
    await expect(container).toBeVisible();
    return await container.evaluate(
      (el) => getComputedStyle(el.querySelector(".cm-editor") ?? el).fontSize,
    );
  }

  /** The color a CSS variable resolves to, as the browser writes a computed `color`. */
  async resolvedColor(name: string): Promise<string> {
    return await this.page.evaluate((n) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${n})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, name);
  }
}
