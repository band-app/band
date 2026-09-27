import { expect, type Locator } from "@playwright/test";

/** Assert a text field opts out of mobile keyboard help: no AutoFill,
 *  autocorrect, auto-capitalisation or spellcheck, so iOS shows no QuickType
 *  suggestions above the keyboard for names, paths and search queries. */
export async function expectNoKeyboardSuggestions(field: Locator): Promise<void> {
  await expect(field).toHaveAttribute("autocomplete", "off");
  await expect(field).toHaveAttribute("autocorrect", "off");
  await expect(field).toHaveAttribute("autocapitalize", "off");
  await expect(field).toHaveAttribute("spellcheck", "false");
}
