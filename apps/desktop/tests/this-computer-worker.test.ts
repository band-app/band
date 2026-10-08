/**
 * Integration test for making this Mac a worker (`services/this-computer-worker.ts`).
 *
 * Real files under a sandboxed HOME, a real HTTP server standing in for the hub's tRPC
 * endpoint, and two scripts in place of the processes the module starts: a "bundled worker"
 * that records how it was called, and a `launchctl` that records its arguments. The full flow
 * with a real worker and hub is in `apps/web/e2e-desktop/desktop-this-computer-worker.spec.ts`.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  LAUNCHD_LABEL,
  parseLaunchdPlist,
  plistPath,
  ThisComputerWorker,
} from "../src/main/services/this-computer-worker.ts";

const TOKEN = "admin-token";

function plist(program: string[], env: Record<string, string>): string {
  const vars = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${v.replace(/&/g, "&amp;")}</string>`)
    .join("\n");
  const args = program.map((a) => `    <string>${a}</string>`).join("\n");
  return `<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
</dict>
</plist>
`;
}

describe("this computer as a worker", () => {
  let home: string;
  let hub: Server;
  let hubUrl: string;
  let hosts: Array<{ id: string; status: string }>;
  let workerDir: string;
  let callLog: string;
  let launchctlLog: string;
  const originalHome = process.env.HOME;
  const originalBin = process.env.BAND_LAUNCHCTL_BIN;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "band-this-computer-"));
    process.env.HOME = home;
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    hosts = [];

    // The "bundled worker": records its arguments and whether the token reached it by env.
    workerDir = join(home, "App.app", "Contents", "Resources", "worker");
    mkdirSync(workerDir, { recursive: true });
    callLog = join(home, "worker-calls.json");
    writeFileSync(
      join(workerDir, "band-worker.mjs"),
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({
  args: process.argv.slice(2),
  token: process.env.BAND_WORKER_TOKEN ?? null,
  electronAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
}) + "\\n");
`,
    );

    launchctlLog = join(home, "launchctl.log");
    const launchctl = join(home, "launchctl.sh");
    writeFileSync(launchctl, `#!/bin/sh\necho "$@" >> ${JSON.stringify(launchctlLog)}\n`);
    chmodSync(launchctl, 0o755);
    process.env.BAND_LAUNCHCTL_BIN = launchctl;

    hub = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
        return;
      }
      const path = (req.url ?? "").split("?")[0];
      if (path === "/trpc/hosts.list") {
        res.end(JSON.stringify({ result: { data: { hosts } } }));
      } else if (path === "/trpc/tokens.issueWorkerBootstrap") {
        res.end(JSON.stringify({ result: { data: { token: "bwb_secret", hostId: "h-new" } } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: "not found" } }));
      }
    });
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
    const address = hub.address();
    assert(address && typeof address === "object");
    hubUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalBin === undefined) delete process.env.BAND_LAUNCHCTL_BIN;
    else process.env.BAND_LAUNCHCTL_BIN = originalBin;
    await rm(home, { recursive: true, force: true });
  });

  function worker(overrides: { appVersion?: string } = {}) {
    return new ThisComputerWorker({
      home,
      platform: "darwin",
      uid: 501,
      node: process.execPath,
      location: { dir: workerDir, script: join(workerDir, "band-worker.mjs") },
      appVersion: overrides.appVersion ?? "1.2.3",
      computerName: () => "Test Mac",
      onlineTimeoutMs: 300,
      pollMs: 20,
    });
  }

  const hubAccess = () => ({ url: hubUrl, token: TOKEN });

  function calls(): Array<{ args: string[]; token: string | null; electronAsNode: string | null }> {
    if (!existsSync(callLog)) return [];
    return readFileSync(callLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }

  test("parseLaunchdPlist reads the program and environment the worker's installer writes", () => {
    const parsed = parseLaunchdPlist(
      plist(["/usr/bin/node", "/x/band-worker.mjs"], { A: "1", B: "a&b" }),
    );
    assert.deepEqual(parsed.program, ["/usr/bin/node", "/x/band-worker.mjs"]);
    assert.deepEqual(parsed.env, { A: "1", B: "a&b" });
  });

  test("with no service the prompt is pending for a remote hub only, and Not now is remembered", async () => {
    const w = worker();
    assert.equal((await w.status(hubAccess())).promptPending, true);
    assert.equal((await w.status(null)).promptPending, false);
    assert.equal((await w.status(hubAccess())).defaultName, "Test Mac");
    w.markAnswered(hubUrl);
    assert.equal((await w.status(hubAccess())).promptPending, false);
    // Another hub is a new question.
    assert.equal(
      (await w.status({ url: "https://other.example", token: TOKEN })).promptPending,
      true,
    );
  });

  test("an unsupported platform or a build with no bundled worker never prompts", async () => {
    const noWorker = new ThisComputerWorker({
      home,
      platform: "darwin",
      location: null,
      appVersion: "1",
    });
    assert.equal((await noWorker.status(hubAccess())).promptPending, false);
    const linux = new ThisComputerWorker({
      home,
      platform: "linux",
      location: { dir: workerDir, script: join(workerDir, "band-worker.mjs") },
      appVersion: "1",
    });
    const status = await linux.status(hubAccess());
    assert.equal(status.supported, false);
    assert.equal(status.promptPending, false);
  });

  test("S5: a service installed from npm is detected and switched with its id, name and roots, the token only in the environment", async () => {
    writeFileSync(
      plistPath(home),
      plist(
        ["/usr/local/bin/node", "/usr/local/lib/node_modules/@band-app/worker/bin/band-worker.mjs"],
        {
          BAND_HUB_URL: hubUrl,
          BAND_WORKER_TOKEN: "bwb_old",
          BAND_WORKER_ID: "h-existing",
          BAND_WORKER_NAME: "Work Mac",
          BAND_WORKER_ROOTS: "/Users/me/code:/Users/me/more",
          BAND_WORKER_STATE_DIR: "/Users/me/.band/worker",
        },
      ),
    );
    hosts = [{ id: "h-existing", status: "online" }];
    const w = worker();

    const before = await w.status(hubAccess());
    assert.equal(before.installed, true);
    assert.equal(before.bundled, false);
    assert.equal(before.forThisHub, true);
    assert.equal(before.hostId, "h-existing");
    assert.equal(before.promptPending, false);

    const result = await w.switchToBundled(hubAccess());
    assert.deepEqual(result, { ok: true });
    const [call] = calls();
    assert(call);
    assert.deepEqual(call.args, [
      "install-service",
      "--hub",
      hubUrl,
      "--worker-id",
      "h-existing",
      "--name",
      "Work Mac",
      "--state-dir",
      "/Users/me/.band/worker",
      "--root",
      "/Users/me/code",
      "--root",
      "/Users/me/more",
    ]);
    assert.equal(call.token, "bwb_old");
    assert.equal(call.electronAsNode, "1");
    assert(!call.args.includes("bwb_old"));
  });

  test("add installs through the bundled worker with a hub-issued token, and rolls back when the host never connects", async () => {
    const w = worker();
    const result = await w.add(hubAccess(), {
      name: "  My Mac ",
      roots: ["/Users/me/code", "relative"],
    });
    // The stub hub never reports the host online, so the install fails and is undone.
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /did not connect/);
    const [install, uninstall] = calls();
    assert.deepEqual(install?.args, [
      "install-service",
      "--hub",
      hubUrl,
      "--worker-id",
      "h-new",
      "--name",
      "My Mac",
      "--root",
      "/Users/me/code",
    ]);
    assert.equal(install?.token, "bwb_secret");
    assert.deepEqual(uninstall?.args, ["uninstall-service"]);
    assert.equal(uninstall?.token, null);
    assert.equal((await w.status(hubAccess())).promptPending, true);
  });

  test("add succeeds once the host is online, and the status then reads bundled and online", async () => {
    hosts = [{ id: "h-new", status: "online" }];
    const w = worker();
    assert.deepEqual(await w.add(hubAccess(), { name: "My Mac" }), { ok: true });
    // Answered, so the prompt is not shown again for this hub.
    writeFileSync(
      plistPath(home),
      plist([process.execPath, join(workerDir, "band-worker.mjs")], {
        BAND_HUB_URL: hubUrl,
        BAND_WORKER_ID: "h-new",
      }),
    );
    const status = await w.status(hubAccess());
    assert.equal(status.bundled, true);
    assert.equal(status.hostStatus, "online");
    assert.equal(status.version, "1.2.3");
  });

  test("a hub that refuses the token makes add fail with its message", async () => {
    const w = worker();
    const result = await w.add({ url: hubUrl, token: "wrong" }, { name: "x" });
    assert.deepEqual(result, { ok: false, error: "Unauthorized" });
    assert.deepEqual(calls(), []);
  });

  test("the service restarts once after an app update, and only when it runs the bundled worker", () => {
    writeFileSync(
      plistPath(home),
      plist([process.execPath, join(workerDir, "band-worker.mjs")], { BAND_HUB_URL: hubUrl }),
    );
    assert.equal(worker({ appVersion: "1.0.0" }).restartAfterUpdate(), true);
    assert.match(
      readFileSync(launchctlLog, "utf8"),
      new RegExp(`kickstart -k gui/501/${LAUNCHD_LABEL}`),
    );
    // Same version again: nothing to do.
    assert.equal(worker({ appVersion: "1.0.0" }).restartAfterUpdate(), false);
    assert.equal(worker({ appVersion: "1.1.0" }).restartAfterUpdate(), true);

    writeFileSync(
      plistPath(home),
      plist(["/usr/local/bin/node", "/elsewhere/band-worker.mjs"], {}),
    );
    assert.equal(worker({ appVersion: "2.0.0" }).restartAfterUpdate(), false);
  });
});
