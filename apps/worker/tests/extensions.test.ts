import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type ExtensionsFetchParams,
  type ExtensionsFetchReply,
  type ExtensionsSyncReply,
  type LeaseRenewReply,
  METHOD_EXTENSIONS_FETCH,
  METHOD_EXTENSIONS_SYNC,
  METHOD_LEASE_RENEW,
  METHOD_PLUGIN_CALL,
} from "@band-app/link";
import { echoArchive } from "../../hub/tests/helpers/extension-archive.ts";
import { serviceSpawnSpec } from "../src/extensions.ts";
import {
  call,
  cleanup,
  git,
  makeRepo,
  startHub,
  startWorker,
  type TestHub,
  type TestWorker,
  tmpDir,
  waitFor,
} from "./helpers.ts";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("serviceSpawnSpec", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    BAND_TOKEN: "secret",
    BAND_HUB_URL: "http://hub",
    GIT_CONFIG_COUNT: "1",
    GH_TOKEN: "t",
  };

  it("sets ELECTRON_RUN_AS_NODE itself under Electron, whatever the worker inherited", () => {
    const spec = serviceSpawnSpec("/ext/service.mjs", {
      env,
      execPath: "/Applications/Band.app/Contents/MacOS/Band",
      electron: true,
    });
    assert.equal(spec.command, "/Applications/Band.app/Contents/MacOS/Band");
    assert.deepEqual(spec.args, ["/ext/service.mjs"]);
    assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
  });

  it("passes the simulator test name prefix and no other BAND_* variable", () => {
    const spec = serviceSpawnSpec("/ext/service.mjs", {
      env: { ...env, BAND_SIMULATOR_NAME_PREFIX: "band-test-x-1" },
      execPath: "/usr/bin/node",
      electron: false,
    });
    assert.deepEqual(
      Object.keys(spec.env).filter((k) => k.startsWith("BAND_")),
      ["BAND_SIMULATOR_NAME_PREFIX"],
    );
    assert.equal(spec.env.BAND_SIMULATOR_NAME_PREFIX, "band-test-x-1");
  });

  it("leaves it unset under plain Node and passes no BAND_*, GIT_CONFIG_* or token variable", () => {
    for (const electron of [false, true]) {
      const spec = serviceSpawnSpec("/ext/service.mjs", {
        env,
        execPath: "/usr/bin/node",
        electron,
      });
      assert.equal(spec.env.ELECTRON_RUN_AS_NODE, electron ? "1" : undefined);
      assert.deepEqual(
        Object.keys(spec.env).filter((k) => /^(BAND_|GIT_|GH_)/.test(k)),
        [],
      );
      assert.equal(spec.env.PATH, "/usr/bin");
    }
  });
});

describe("extension worker services", () => {
  let hub: TestHub;
  let w: TestWorker;
  let repo = "";
  const archives = new Map<string, { bytes: Buffer; sha256: string }>();
  let fetches = 0;

  const add = (opts: Parameters<typeof echoArchive>[0] = {}) => {
    const a = echoArchive(opts);
    archives.set(a.version, a);
    return a;
  };
  const item = (a: { version: string; sha256: string }) => ({
    id: "echo-service",
    version: a.version,
    sha256: a.sha256,
  });
  const sync = (...items: Array<{ id: string; version: string; sha256: string }>) =>
    call<ExtensionsSyncReply>(w.session, METHOD_EXTENSIONS_SYNC, { items });
  const rpc = <T>(method: string, params: unknown = {}) =>
    call<T>(w.session, METHOD_PLUGIN_CALL, {
      pluginId: "echo",
      method,
      params,
      worktreeKey: "ws",
      worktreePath: repo,
    });
  const renew = (ttlMs: number) =>
    call<LeaseRenewReply>(w.session, METHOD_LEASE_RENEW, { ttlMs, blockedPaths: [] });

  before(async () => {
    process.env.BAND_TOKEN = "a-secret-the-service-must-not-see";
    process.env.GIT_CONFIG_COUNT = "0";
    hub = await startHub();
    w = await startWorker(hub, { options: { extensions: { restartBackoffMs: 5 } } });
    repo = makeRepo(w.root);
    w.session.handle(METHOD_EXTENSIONS_FETCH, (params) => {
      const p = params as ExtensionsFetchParams;
      const a = archives.get(p.version);
      if (!a) throw new Error(`no archive ${p.version}`);
      fetches++;
      const ch = w.session.openChannel("payload");
      ch.discardIncoming();
      ch.send(a.bytes).then(
        () => ch.end(),
        () => undefined,
      );
      const reply: ExtensionsFetchReply = { sha256: a.sha256, size: a.bytes.length, chan: ch.id };
      return reply;
    });
  });
  after(async () => {
    await w.worker.stop();
    Reflect.deleteProperty(process.env, "BAND_TOKEN");
    Reflect.deleteProperty(process.env, "GIT_CONFIG_COUNT");
    await hub.close();
    cleanup(w.root, w.stateDir);
  });

  it("downloads, starts the service and routes a call, with a clean child environment", async () => {
    const a = add();
    const reply = await sync(item(a));
    assert.deepEqual(
      reply.services.map((s) => [s.extensionId, s.capability, s.state]),
      [["echo-service", "echo", "running"]],
    );
    assert.deepEqual(await rpc("echo", { a: 1 }), { a: 1 });
    assert.equal(await rpc("workerId"), w.worker.workerId);
    const keys = await rpc<string[]>("envKeys");
    assert.deepEqual(
      keys.filter((k) => /^(BAND_|GIT_CONFIG|GH_|ELECTRON)/.test(k)),
      [],
    );
    assert.ok(keys.includes("PATH"));
    assert.ok(existsSync(join(w.stateDir, "extensions", "echo-service", "1.0.0", "service.mjs")));
    // The same set again downloads nothing and keeps the process.
    const pid = await rpc<number>("pid");
    const before = fetches;
    await sync(item(a));
    assert.equal(fetches, before);
    assert.equal(await rpc("pid"), pid);
  });

  it("tells a service a worktree was removed even when it never served that worktree", async () => {
    const outside = tmpDir("band-worker-outside-");
    try {
      const worktree = join(outside, "feature");
      git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
      await call(w.session, "repos.map", { remoteUrl: `file://${repo}`, path: repo });
      await call(w.session, "worktree.remove", { repoPath: repo, path: worktree });
      assert.ok((await rpc<string[]>("released")).includes(`:path:${worktree}`));
    } finally {
      cleanup(outside);
    }
  });

  it("refuses an archive that does not match its sha256", async () => {
    const good = add({ version: "9.0.0" });
    const first = archives.get("1.0.0");
    assert.ok(first);
    const reply = await sync(item({ version: "1.0.0", sha256: first.sha256 }), {
      ...item(good),
      sha256: "0".repeat(64),
    });
    assert.match(reply.problems[0]?.reason ?? "", /sha256/);
  });

  it("swaps to a new version and removes the old folder, then stops and removes on uninstall", async () => {
    const oldPid = await rpc<number>("pid");
    const v2 = add({ version: "2.0.0" });
    const reply = await sync(item(v2));
    assert.equal(reply.services[0]?.version, "2.0.0");
    assert.equal(await rpc("version"), "2.0.0");
    assert.notEqual(await rpc("pid"), oldPid);
    await waitFor(() => !alive(oldPid), 5000, "the old process to stop");
    assert.equal(existsSync(join(w.stateDir, "extensions", "echo-service", "1.0.0")), false);

    const pid = await rpc<number>("pid");
    await sync();
    await waitFor(() => !alive(pid), 5000, "the process to stop");
    assert.equal(existsSync(join(w.stateDir, "extensions", "echo-service")), false);
    await assert.rejects(rpc("echo"), /unknown plugin/);
  });

  it("does not start a service whose requirements are not met, and says why", async () => {
    const a = add({ version: "3.0.0", requires: ["os=nonexistent"] });
    const reply = await sync(item(a));
    assert.equal(reply.services[0]?.state, "not-eligible");
    assert.match(reply.services[0]?.reason ?? "", /needs os=nonexistent/);
    await assert.rejects(rpc("echo"), /cannot run echo/);
  });

  it("restarts a crashing service with backoff and marks it failed after 3 crashes in 5 minutes", async () => {
    const a = add({ version: "4.0.0" });
    await sync(item(a));
    const stateNow = async () => {
      const r = await call<ExtensionsSyncReply>(w.session, "extensions.status");
      return r.services[0];
    };
    const pids = new Set<number>();
    for (let crash = 1; crash <= 3; crash++) {
      await waitFor(async () => (await stateNow())?.state === "running", 5000, "a running service");
      pids.add(await rpc<number>("pid"));
      await rpc("crash");
      if (crash < 3) {
        await waitFor(async () => (await stateNow())?.state !== "running", 5000, "the crash");
      }
    }
    await waitFor(async () => (await stateNow())?.state === "failed", 5000, "failed");
    assert.equal(pids.size, 3, "each restart is a new process");
    assert.match((await stateNow())?.reason ?? "", /crashed 3 times in 5 minutes/);
    await assert.rejects(rpc("echo"), /cannot run echo: crashed 3 times/);
    await sync();
  });

  it("kills the process on a lease fence and starts it again when the hub renews", async () => {
    const a = add({ version: "5.0.0" });
    await sync(item(a));
    await renew(120_000);
    const pid = await rpc<number>("pid");
    await renew(1000);
    await waitFor(() => !alive(pid), 30_000, "the fence to kill the service");
    let refusal = "";
    for (let attempt = 0; attempt < 20 && !refusal; attempt++) {
      try {
        await rpc("echo");
        assert.fail("a fenced worker answered a service call");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/link dropped|link closed/i.test(message)) await new Promise((r) => setTimeout(r, 500));
        else refusal = message;
      }
    }
    assert.match(refusal, /lost the hub's lease/);
    await renew(60_000);
    assert.deepEqual(await rpc("echo", { again: true }), { again: true });
    assert.notEqual(await rpc("pid"), pid);
  });

  it("starts nothing while the lease is not valid, and starts the service once the hub renews", async () => {
    await renew(120_000);
    await sync();
    await renew(1000);
    await waitFor(async () => {
      const r = await call<ExtensionsSyncReply>(w.session, "extensions.status");
      return r.services.length === 0;
    }, 5000);
    // The lease runs out, then the hub syncs a new extension version: it is unpacked but not started.
    await new Promise((r) => setTimeout(r, 2500));
    const a = add({ version: "6.0.0" });
    let reply: ExtensionsSyncReply | undefined;
    for (let attempt = 0; attempt < 20 && !reply; attempt++) {
      try {
        reply = await sync(item(a));
      } catch (err) {
        if (!/link dropped|link closed/i.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.equal(reply?.services[0]?.state, "stopped");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(
      (await call<ExtensionsSyncReply>(w.session, "extensions.status")).services[0]?.state,
      "stopped",
    );
    // A renewal starts it without any call asking for it.
    await renew(60_000);
    await waitFor(
      async () =>
        (await call<ExtensionsSyncReply>(w.session, "extensions.status")).services[0]?.state ===
        "running",
      10_000,
      "the service to start after the renewal",
    );
    assert.deepEqual(await rpc("echo", { ok: 1 }), { ok: 1 });
  });

  it("kills the process when the worker shuts down", async () => {
    const pid = await rpc<number>("pid");
    await w.worker.stop();
    await waitFor(() => !alive(pid), 10_000, "the service to stop with the worker");
  });
});
