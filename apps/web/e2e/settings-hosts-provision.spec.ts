/**
 * Settings › Hosts › "Add a host": the one-line provisioning command, its expiry, the live status
 * and the log, driven through the real Settings dialog against the real server. The test pastes
 * the command into `sh` on this machine (a temp HOME) with `BAND_WORKER_CMD` set to a worker that
 * fails, so the dialog shows the host as failed with the log, and the log holds no token.
 * `apps/hub/tests/provisioning.test.ts` covers the script with a real worker.
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-provision-token";

let server: ServerHandle;
let tmpHome: string;
let machine: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  machine = realpathSync(mkdtempSync(join(tmpdir(), "band-e2e-provision-")));
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(machine, { recursive: true, force: true });
});

/** Pastes a command into `sh` on a blank machine whose worker install fails. */
function runOnBlankMachine(command: string): Promise<{ code: number; out: string }> {
  const worker = join(machine, "failing-worker.sh");
  writeFileSync(
    worker,
    '#!/bin/sh\necho "no systemd here" >&2\necho "token $BAND_WORKER_TOKEN" >&2\nexit 1\n',
  );
  chmodSync(worker, 0o755);
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: machine,
        TMPDIR: machine,
        BAND_WORKER_CMD: worker,
        BAND_PROVISION_ROOT_STEPS: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c;
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c;
    });
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

test("shows the command with its expiry and follows a failing run to its log", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");

  await settingsPage.getProvisioningCommand();
  await expect(settingsPage.provisionCommand()).toHaveValue(
    new RegExp(
      `^curl -fsSL ${server.url.replace(/\./g, "\\.")}/api/provision/bpc_[\\w-]+/script \\| sh$`,
    ),
  );
  const expiresAt = Number(await settingsPage.provisionExpiry().getAttribute("data-expires-at"));
  expect(expiresAt - Date.now()).toBeGreaterThan(55 * 60 * 1000);
  expect(expiresAt - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
  await expect(settingsPage.provisionCopyCloudInitButton()).toBeVisible();
  await expect(settingsPage.provisionStatus()).toHaveAttribute("data-status", "waiting");

  const command = await settingsPage.provisionCommand().inputValue();
  const result = await runOnBlankMachine(command);
  expect(result.code).toBe(1);
  const token = /token (bwb_[\w-]+)/.exec(result.out)?.[1];
  expect(token).toBeTruthy();

  await expect(settingsPage.provisionStatus()).toHaveAttribute("data-status", "failed", {
    timeout: 15_000,
  });
  await expect(settingsPage.provisionLog()).toContainText("no systemd here");
  await expect(settingsPage.provisionLog()).not.toContainText(token as string);
});
