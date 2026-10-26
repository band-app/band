import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { RpcError } from "@band-app/link";
import { detectServiceManager, installPrefix, updateWorker } from "../src/update.ts";
import { WORKER_VERSION } from "../src/worker.ts";
import {
  call,
  cleanup,
  spawnWorkerProcess,
  startHub,
  startWorker,
  TOKEN,
  tmpDir,
  waitFor,
} from "./helpers.ts";

const dirs: string[] = [];
after(() => cleanup(...dirs));

/** Fake `npm`, `launchctl` and `systemctl` that log their arguments; `npm` fails when FAKE_NPM_FAIL is set. */
function fakeBins(): { env: NodeJS.ProcessEnv; calls: () => string[] } {
  const dir = tmpDir("band-worker-fakebin-");
  dirs.push(dir);
  const log = join(dir, "calls.log");
  const bins: Record<string, string> = {};
  for (const name of ["npm", "launchctl", "systemctl"]) {
    const file = join(dir, name);
    const fail =
      name === "npm"
        ? 'if [ -n "$FAKE_NPM_FAIL" ]; then echo "npm ERR! EACCES permission denied" >&2; exit 243; fi\n'
        : "";
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${fail}`);
    chmodSync(file, 0o755);
    bins[name] = file;
  }
  return {
    env: {
      BAND_NPM_BIN: bins.npm,
      BAND_LAUNCHCTL_BIN: bins.launchctl,
      BAND_SYSTEMCTL_BIN: bins.systemctl,
    },
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

const quiet = () => undefined;
const PREFIX = "/tmp/band-prefix";

describe("service manager detection", () => {
  it("knows launchd by its label and systemd by the invocation id", () => {
    assert.equal(
      detectServiceManager({ XPC_SERVICE_NAME: "app.band.worker" }, "darwin"),
      "launchd",
    );
    assert.equal(detectServiceManager({ XPC_SERVICE_NAME: "0" }, "darwin"), null);
    assert.equal(detectServiceManager({ INVOCATION_ID: "abc" }, "linux", 1000), "systemd");
    assert.equal(detectServiceManager({ INVOCATION_ID: "abc" }, "linux", 0), null);
    assert.equal(detectServiceManager({}, "linux"), null);
    assert.equal(detectServiceManager({ INVOCATION_ID: "abc" }, "darwin"), null);
  });
});

describe("updateWorker", () => {
  it("installs with npm, then restarts through systemd", async () => {
    const fake = fakeBins();
    const out = await updateWorker("0.51.0", {
      manager: "systemd",
      prefix: PREFIX,
      env: fake.env,
      restartDelayMs: 10,
      log: quiet,
    });
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(fake.calls(), [`npm i -g --prefix ${PREFIX} @band-app/worker@0.51.0`]);
    await waitFor(() => fake.calls().length === 2);
    assert.equal(fake.calls()[1], "systemctl --user restart band-worker");
  });

  it("restarts a launchd worker with kickstart -k", async () => {
    const fake = fakeBins();
    await updateWorker("0.51.0", {
      manager: "launchd",
      prefix: PREFIX,
      env: fake.env,
      uid: 501,
      restartDelayMs: 10,
      log: quiet,
    });
    await waitFor(() => fake.calls().length === 2);
    assert.equal(fake.calls()[1], "launchctl kickstart -k gui/501/app.band.worker");
  });

  it("keeps running and reports the error when the install fails, without restarting", async () => {
    const fake = fakeBins();
    await assert.rejects(
      updateWorker("0.51.0", {
        manager: "systemd",
        prefix: PREFIX,
        env: { ...fake.env, FAKE_NPM_FAIL: "1" },
        restartDelayMs: 10,
        log: quiet,
      }),
      (err: RpcError) => /npm install failed \(exit 243\).*EACCES/s.test(err.message),
    );
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(fake.calls(), [`npm i -g --prefix ${PREFIX} @band-app/worker@0.51.0`]);
  });

  it("refuses anything but plain MAJOR.MINOR.PATCH before it reaches npm", async () => {
    const fake = fakeBins();
    for (const bad of ["1.0.0; touch /tmp/pwned", "latest", "v1.2.3", "1.2.3-rc.1", "$(id)", 5]) {
      await assert.rejects(
        updateWorker(bad, { manager: "systemd", prefix: PREFIX, env: fake.env, log: quiet }),
        RpcError,
        String(bad),
      );
    }
    assert.deepEqual(fake.calls(), []);
  });

  it("refuses when no service manager supervises the worker", async () => {
    const fake = fakeBins();
    await assert.rejects(
      updateWorker("0.51.0", { manager: null, prefix: PREFIX, env: fake.env, log: quiet }),
      /does not run under launchd or a systemd user unit/,
    );
    assert.deepEqual(fake.calls(), []);
  });
});

describe("npm location and prefix", () => {
  it("derives the prefix from an npm global layout and refuses any other", () => {
    assert.equal(
      installPrefix("/home/u/.local/lib/node_modules/@band-app/worker/dist/update.mjs", "linux"),
      "/home/u/.local",
    );
    assert.equal(installPrefix("/repo/apps/worker/src/update.ts", "linux"), null);
    assert.equal(
      installPrefix("/Applications/Band.app/Contents/Resources/worker/worker.mjs", "darwin"),
      null,
    );
  });

  it("refuses to run npm when the worker is not an npm global install", async () => {
    const fake = fakeBins();
    await assert.rejects(
      updateWorker("0.51.0", { manager: "systemd", prefix: null, env: fake.env, log: quiet }),
      /does not run from an npm global install/,
    );
    assert.deepEqual(fake.calls(), []);
  });

  it("finds the npm beside node with no PATH and puts node's directory on the child's PATH", async () => {
    const nodeDir = tmpDir("band-worker-nodedir-");
    dirs.push(nodeDir);
    writeFileSync(join(nodeDir, "node"), "");
    writeFileSync(join(nodeDir, "npm"), "");
    const seen: { cmd: string; args: string[]; path?: string }[] = [];
    await updateWorker("0.51.0", {
      manager: "systemd",
      prefix: PREFIX,
      execPath: join(nodeDir, "node"),
      env: { PATH: "/usr/bin:/bin", BAND_SYSTEMCTL_BIN: "true" },
      run: async (cmd, args, env) => {
        seen.push({ cmd, args, path: env.PATH });
        return { code: 0, stderr: "" };
      },
      restartDelayMs: 10,
      log: quiet,
    });
    assert.equal(seen[0].cmd, join(nodeDir, "npm"));
    assert.deepEqual(seen[0].args, ["i", "-g", "--prefix", PREFIX, "@band-app/worker@0.51.0"]);
    assert.equal(seen[0].path, `${nodeDir}:/usr/bin:/bin`);
  });

  it("names where it looked when npm is missing", async () => {
    await assert.rejects(
      updateWorker("0.51.0", {
        manager: "systemd",
        prefix: PREFIX,
        execPath: "/nonexistent/bin/node",
        env: { PATH: "" },
        run: async () => ({ code: 1, stderr: "spawn npm ENOENT" }),
        log: quiet,
      }),
      /npm not found in \/nonexistent\/bin or on PATH/,
    );
  });

  it("makes node-pty's spawn-helper executable after the install", async () => {
    const prefix = tmpDir("band-worker-prefix-");
    dirs.push(prefix);
    const pkg = join(prefix, "lib", "node_modules", "@band-app", "worker");
    const helperDir = join(pkg, "node_modules", "node-pty", "prebuilds", "darwin-arm64");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(join(pkg, "package.json"), "{}");
    writeFileSync(join(pkg, "node_modules", "node-pty", "package.json"), "{}");
    const helper = join(helperDir, "spawn-helper");
    writeFileSync(helper, "");
    chmodSync(helper, 0o644);
    await updateWorker("0.51.0", {
      manager: "systemd",
      prefix,
      env: { BAND_NPM_BIN: "npm", BAND_SYSTEMCTL_BIN: "true" },
      run: async () => ({ code: 0, stderr: "" }),
      restartDelayMs: 10,
      log: quiet,
    });
    assert.ok(statSync(helper).mode & 0o100, "spawn-helper is executable");
  });
});

describe("over the link", () => {
  it("says why it cannot update when it runs from a checkout, and refuses worker.update", async () => {
    const hub = await startHub();
    const w = await startWorker(hub, { options: { serviceManager: "systemd" } });
    try {
      assert.equal(w.session.hello.version, WORKER_VERSION);
      assert.equal(w.session.hello.serviceManager, undefined);
      assert.match(w.session.hello.updateBlocked ?? "", /does not run from an npm global install/);
      await assert.rejects(
        call(w.session, "worker.update", { version: "0.51.0" }),
        /does not run from an npm global install/,
      );
    } finally {
      await w.worker.stop();
      await hub.close();
      cleanup(w.root, w.stateDir);
    }
  });

  it("reports no service manager when none supervises it, and refuses to update", async () => {
    const hub = await startHub();
    const w = await startWorker(hub, { options: { serviceManager: null } });
    try {
      assert.equal(w.session.hello.serviceManager, undefined);
      await assert.rejects(
        call(w.session, "worker.update", { version: "0.51.0" }),
        /does not run under/,
      );
    } finally {
      await w.worker.stop();
      await hub.close();
      cleanup(w.root, w.stateDir);
    }
  });
});

describe("a hub that refuses the worker's version", () => {
  it("logs the reason and waits instead of redialing", async () => {
    const reason = "worker 0.47.0 is too old for hub 0.50.0, update it to 0.50.0";
    const hub = await startHub({ refuse: { reason, code: "version-incompatible" } });
    const root = tmpDir();
    const stateDir = tmpDir("band-worker-state-");
    dirs.push(root, stateDir);
    try {
      const started = Date.now();
      const proc = spawnWorkerProcess(
        ["--hub", hub.url, "--token", TOKEN, "--root", root, "--state-dir", stateDir],
        { BAND_WORKER_VERSION_RETRY_MS: "1500" },
      );
      const { code } = await proc.exited;
      assert.equal(code, 1);
      assert.ok(Date.now() - started >= 1400, "the worker waited before it exited");
      assert.ok(proc.output().includes(reason), proc.output());
      assert.equal(hub.hellos.length, 1, "no redial while it waited");
    } finally {
      await hub.close();
    }
  });
});
