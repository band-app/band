/**
 * Rendered geometry of an element, for tests that check a menu, dialog or
 * popover stays inside the window. Boxes are in viewport pixels
 * (`boundingBox()`), so they already include the app zoom.
 */

import { expect, type Locator } from "@playwright/test";

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The element's box once its open animation (menus and dialogs zoom in
 *  from 95%) has finished. */
export async function readSettledBox(locator: Locator): Promise<Box> {
  await locator.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no layout box");
  return { top: box.y, bottom: box.y + box.height, left: box.x, right: box.x + box.width };
}

/** Assert the element's settled box lies entirely inside the viewport. */
export async function expectInsideViewport(
  locator: Locator,
  viewport: { width: number; height: number },
): Promise<void> {
  const box = await readSettledBox(locator);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(viewport.height);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(viewport.width);
}
