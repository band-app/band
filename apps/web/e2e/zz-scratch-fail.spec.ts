import { expect, test } from "@playwright/test";

test("scratch failure", async ({ page }) => {
  await page.setContent("<p>x</p>");
  await expect(page.locator("p")).toHaveText("y", { timeout: 1000 });
});
