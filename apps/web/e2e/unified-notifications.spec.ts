/**
 * The CLI and Claude Code hooks notices render as notifications in the bottom-right stack, with
 * a title, details, an Install action and a close button, and nothing renders as a banner in the
 * sidebar. Real hub with a temp HOME, a fake `band` on PATH, `BAND_CLI_PATH` on a fake binary and
 * `BAND_CLI_SYMLINK_PATH` in a directory that does not exist, so both conditions hold.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { CliBannerPage } from "./pages/CliBannerPage";
import { ToastHostPage } from "./pages/ToastHostPage";

const TOKEN = "e2e-unified-notifications-token";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let home: string;

test.beforeAll(async () => {
  home = createTmpHome();
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const binary = join(bin, "band");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  mkdirSync(join(home, ".claude"), { recursive: true });
  seedSettings(home, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({
    tmpHome: home,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BAND_CLI_PATH: binary,
      BAND_CLI_SYMLINK_PATH: join(home, "usr-local-bin", "band"),
    },
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(home);
});

test("S1: the CLI and hooks notices are notifications in the bottom-right stack", async ({
  page,
}) => {
  const cli = new CliBannerPage(page, server.url, TOKEN);
  const toasts = new ToastHostPage(page);
  await cli.goto();
  await cli.install();

  for (const notice of [toasts.cliNotice, toasts.hooksNotice]) {
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button", { name: "Install" })).toBeVisible();
    await expect(toasts.closeButton(notice)).toBeVisible();
  }
  await expect(toasts.hooksNotice).toContainText("Claude Code hooks need to be installed");
  await expect(toasts.sidebarBanners).toHaveCount(0);
  const placement = await toasts.readPlacement(toasts.hooksNotice);
  expect(placement.left).toBeGreaterThan(placement.viewportWidth / 2);
  expect(placement.top).toBeGreaterThan(placement.viewportHeight / 2);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("S5: the stack is full width", async ({ page }) => {
    const cli = new CliBannerPage(page, server.url, TOKEN);
    const toasts = new ToastHostPage(page);
    await cli.goto();
    await expect(toasts.hooksNotice).toBeVisible();
    const placement = await toasts.readPlacement(toasts.hooksNotice);
    expect(Math.round(placement.left)).toBe(16);
    expect(Math.round(placement.viewportWidth - placement.right)).toBe(16);
  });
});
