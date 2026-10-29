/**
 * The "Install band CLI" banner appears only when a person can act on it, names the machine in
 * its message, and clears once the problem is fixed. Real hub with `BAND_CLI_PATH` on a fake
 * binary and `BAND_CLI_SYMLINK_PATH` in a temp dir, so nothing touches `/usr/local/bin`.
 * The admin and non-admin split is covered in `apps/hub/tests/cli-check.test.ts`.
 */

import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcMutateData } from "./helpers/trpc";
import { CliBannerPage } from "./pages/CliBannerPage";

const TOKEN = "e2e-cli-banner-token";

test.use({ viewport: { width: 1280, height: 800 } });

interface World {
  server: ServerHandle;
  home: string;
  binary: string;
  linkDir: string;
}

const worlds: World[] = [];

async function boot(env: Record<string, string> = {}): Promise<World> {
  const home = createTmpHome();
  const binary = join(home, "pkg", "bin", "band");
  mkdirSync(join(binary, ".."), { recursive: true });
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  // The directory does not exist yet, so the check fails until the test makes it.
  const linkDir = join(home, "usr-local-bin");
  seedSettings(home, { tokenSecret: TOKEN });
  const server = await startServer({
    tmpHome: home,
    env: { BAND_CLI_PATH: binary, BAND_CLI_SYMLINK_PATH: join(linkDir, "band"), ...env },
  });
  const world = { server, home, binary, linkDir };
  worlds.push(world);
  return world;
}

test.afterAll(async () => {
  for (const w of worlds.splice(0)) {
    await w.server.close();
    cleanupTmpHome(w.home);
  }
});

test("S3: a hub with no local worker shows no banner", async ({ page }) => {
  const w = await boot({ BAND_LOCAL_WORKER: "off" });
  const cli = new CliBannerPage(page, w.server.url, TOKEN);
  await cli.goto();
  await expect(cli.banner).toHaveCount(0);
});

test("S3: a non-admin device sees no banner while an admin does", async ({ page }) => {
  const w = await boot();
  const { token } = await trpcMutateData<{ token: string }>(
    w.server.url,
    TOKEN,
    "tokens.createDevice",
    { label: "phone" },
  );
  const admin = new CliBannerPage(page, w.server.url, TOKEN);
  await admin.goto();
  await expect(admin.banner).toBeVisible();

  const device = new CliBannerPage(page, w.server.url, token);
  await device.goto();
  await expect(device.banner).toHaveCount(0);
});

test("S4, S5: the banner names the hub's server, then clears when the window regains focus", async ({
  page,
}) => {
  const w = await boot();
  const cli = new CliBannerPage(page, w.server.url, TOKEN);
  await cli.goto();
  await expect(cli.banner).toBeVisible();

  await cli.install();
  await expect(cli.message).toContainText("On the hub's server, run: sudo ln -sf");

  // Someone fixes it on the server.
  mkdirSync(w.linkDir, { recursive: true });
  symlinkSync(w.binary, join(w.linkDir, "band"));
  await cli.regainFocus();
  await expect(cli.banner).toHaveCount(0);
});

test("S4: clicking Install again after the problem is fixed clears the banner", async ({
  page,
}) => {
  const w = await boot();
  const cli = new CliBannerPage(page, w.server.url, TOKEN);
  await cli.goto();
  await cli.install();
  await expect(cli.message).toContainText("On the hub's server");

  mkdirSync(w.linkDir, { recursive: true });
  await cli.install();
  await expect(cli.banner).toHaveCount(0);
});
