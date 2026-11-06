/**
 * Test for the hub as a launchd service (`services/hub-service.ts`).
 *
 * Real files under a sandboxed HOME and a `launchctl` script that records its arguments and
 * keeps one "loaded" flag. Health is answered by a stand-in function, because the hub itself
 * is not started here. The real hub behind a fake launchd, a quit app and a switch to a remote
 * hub are in `apps/web/e2e-desktop/desktop-hub-service.spec.ts`.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { HUB_LAUNCHD_LABEL, HubService, hubPlistPath } from "../src/main/services/hub-service.ts";
import {
  parseLaunchdPlist,
  ThisComputerWorker,
} from "../src/main/services/this-computer-worker.ts";

const TOKEN = "service-hub-token";
const APP = "/Applications/Band.app/Contents/MacOS/Band";
const WEB_DIR = "/Applications/Band.app/Contents/Resources/web";

describe("hub service", () => {
  let home: string;
  let log: string;
  let freed: number[];
  const originalHome = process.env.HOME;
  const originalBin = process.env.BAND_LAUNCHCTL_BIN;

  const calls = (): string[] =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

  const service = (appVersion: string) =>
    new HubService({
      home,
      uid: 501,
      platform: "darwin",
      node: APP,
      appVersion,
      isPackaged: true,
      healthTimeoutMs: 2_000,
      pollMs: 5,
      checkHealth: async (_port, token) => token === TOKEN,
      freePort: async (port) => {
        freed.push(port);
      },
    });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "band-hub-service-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".band"), { recursive: true });
    writeFileSync(join(home, ".band", "settings.json"), JSON.stringify({ tokenSecret: TOKEN }));
    freed = [];
    log = join(home, "launchctl.log");
    const flag = join(home, "loaded");
    const launchctl = join(home, "launchctl.sh");
    writeFileSync(
      launchctl,
      `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
case "$1" in
  bootstrap) touch ${JSON.stringify(flag)} ;;
  bootout) rm -f ${JSON.stringify(flag)} ;;
  print) [ -e ${JSON.stringify(flag)} ] || exit 113 ;;
esac
`,
    );
    chmodSync(launchctl, 0o755);
    process.env.BAND_LAUNCHCTL_BIN = launchctl;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalBin === undefined) delete process.env.BAND_LAUNCHCTL_BIN;
    else process.env.BAND_LAUNCHCTL_BIN = originalBin;
    await rm(home, { recursive: true, force: true });
  });

  test("a first start installs a plist that runs the bundled hub through the app executable", async () => {
    const started = await service("1.0.0").ensureRunning({ webDir: WEB_DIR, port: 4567 });

    assert.equal(started.token, TOKEN);
    assert.equal(started.port, 4567);
    assert.equal(started.restarted, false);
    assert.deepEqual(freed, [4567]);

    const text = readFileSync(hubPlistPath(home), "utf8");
    const { program, env } = parseLaunchdPlist(text);
    assert.equal(program[0], APP);
    assert.equal(program[1], `${WEB_DIR}/dist/start-server.mjs`);
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(env.PORT, "4567");
    assert.equal(env.BAND_HOME, join(home, ".band"));
    assert.equal(env.BAND_PACKAGED, "1");
    assert.match(text, new RegExp(`<string>${HUB_LAUNCHD_LABEL}</string>`));
    assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(text, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
    // The plist names no secret: the hub reads its token from settings.json.
    assert.ok(!text.includes(TOKEN));
    assert.deepEqual(calls(), [`bootstrap gui/501 ${hubPlistPath(home)}`]);
  });

  test("a start with the same version leaves a running hub alone", async () => {
    await service("1.0.0").ensureRunning({ webDir: WEB_DIR, port: 4567 });
    const started = await service("1.0.0").ensureRunning({ webDir: WEB_DIR, port: 4567 });

    assert.equal(started.restarted, false);
    assert.deepEqual(
      calls().filter((c) => !c.startsWith("print")),
      [`bootstrap gui/501 ${hubPlistPath(home)}`],
    );
  });

  test("a new app version restarts the hub, then the worker service", async () => {
    await service("1.0.0").ensureRunning({ webDir: WEB_DIR, port: 4567 });

    // A bundled worker service installed by the same app.
    const workerPlist = join(home, "Library", "LaunchAgents", "app.band.worker.plist");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      workerPlist,
      `<plist><dict><key>ProgramArguments</key><array><string>${APP}</string><string>${WEB_DIR}/../worker/band-worker.mjs</string></array></dict></plist>`,
    );
    const worker = new ThisComputerWorker({
      home,
      uid: 501,
      platform: "darwin",
      node: APP,
      appVersion: "2.0.0",
      location: { dir: `${WEB_DIR}/../worker`, script: `${WEB_DIR}/../worker/band-worker.mjs` },
    });

    const started = await service("2.0.0").ensureRunning({ webDir: WEB_DIR, port: 4567 });
    assert.equal(started.restarted, true);
    assert.equal(worker.restartAfterUpdate(), true);

    const kicks = calls().filter((c) => c.startsWith("kickstart"));
    assert.deepEqual(kicks, [
      "kickstart -k gui/501/app.band.hub",
      "kickstart -k gui/501/app.band.worker",
    ]);

    // Once per version.
    const again = await service("2.0.0").ensureRunning({ webDir: WEB_DIR, port: 4567 });
    assert.equal(again.restarted, false);
  });

  test("a moved app reloads the service with the new path", async () => {
    await service("1.0.0").ensureRunning({ webDir: WEB_DIR, port: 4567 });
    const moved = "/Users/me/Applications/Band.app/Contents/Resources/web";
    await service("1.0.0").ensureRunning({ webDir: moved, port: 4567 });

    const { program } = parseLaunchdPlist(readFileSync(hubPlistPath(home), "utf8"));
    assert.equal(program[1], `${moved}/dist/start-server.mjs`);
    assert.deepEqual(
      calls().filter((c) => !c.startsWith("print")),
      [
        `bootstrap gui/501 ${hubPlistPath(home)}`,
        "bootout gui/501/app.band.hub",
        `bootstrap gui/501 ${hubPlistPath(home)}`,
      ],
    );
  });

  test("stop boots the service out and removes the plist, and a later start installs it again", async () => {
    const hub = service("1.0.0");
    await hub.ensureRunning({ webDir: WEB_DIR, port: 4567 });
    assert.equal(hub.isInstalled(), true);

    hub.stop();
    assert.equal(hub.isInstalled(), false);
    assert.equal(hub.isRunning(), false);
    assert.ok(calls().includes("bootout gui/501/app.band.hub"));

    await hub.ensureRunning({ webDir: WEB_DIR, port: 4567 });
    assert.equal(hub.isInstalled(), true);
    assert.equal(hub.isRunning(), true);
  });

  test("a hub that never answers health fails with a message", async () => {
    const hub = new HubService({
      home,
      uid: 501,
      platform: "darwin",
      node: APP,
      appVersion: "1.0.0",
      isPackaged: true,
      healthTimeoutMs: 100,
      pollMs: 5,
      checkHealth: async () => false,
      freePort: async () => {},
    });
    await assert.rejects(
      hub.ensureRunning({ webDir: WEB_DIR, port: 4567 }),
      /did not become healthy/,
    );
  });
});
