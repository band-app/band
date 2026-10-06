import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { RpcError } from "@band-app/link";
import { RPC_PATH_DENIED } from "../src/rpc-util.ts";
import {
  BAND_HOME,
  call,
  cleanup,
  git,
  makeRepo,
  startHub,
  startWorker,
  type TestHub,
  type TestWorker,
  tmpDir,
} from "./helpers.ts";

interface Browse {
  path: string;
  parent: string | null;
  home: string;
  entries: Array<{ name: string; path: string; isGit: boolean }>;
  insideRoots: boolean;
}

// The picker may look anywhere under the worker's home, but only `repos.addRoot` widens what the
// hub can read or write. HOME is the test's temp BAND_HOME, so nothing here touches a real home.
describe("repos on a worker", () => {
  let hub: TestHub;
  let w: TestWorker;
  let outside: string;
  let picked: string;
  let remote: string;

  before(async () => {
    hub = await startHub();
    w = await startWorker(hub);
    outside = tmpDir("band-worker-outside-");
    picked = join(BAND_HOME, "code", "picked");
    mkdirSync(picked, { recursive: true });
    git(picked, "init", "-q", "-b", "main");
    git(picked, "commit", "-q", "--allow-empty", "-m", "init");
    remote = join(tmpDir("band-worker-remote-"), "gizmos.git");
    const seed = makeRepo(tmpDir("band-worker-seed-"), "gizmos");
    git(join(seed, ".."), "clone", "-q", "--bare", seed, remote);
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir, outside);
  });

  it("starts the picker at the home directory and marks what is inside the roots", async () => {
    const home = await call<Browse>(w.session, "fs.browse", {});
    assert.equal(home.path, BAND_HOME);
    assert.equal(home.insideRoots, false);
    assert.equal(
      home.entries.some((e) => e.name === "code"),
      true,
    );
    const inRoot = await call<Browse>(w.session, "fs.browse", { path: w.root });
    assert.equal(inRoot.insideRoots, true);
  });

  it("lists a folder outside the roots but under home, and refuses one outside both", async () => {
    const code = await call<Browse>(w.session, "fs.browse", { path: join(BAND_HOME, "code") });
    assert.deepEqual(code.entries, [{ name: "picked", path: picked, isGit: true }]);
    await assert.rejects(
      () => w.session.request("fs.browse", { path: outside }),
      (err) => err instanceof RpcError && err.code === RPC_PATH_DENIED,
    );
  });

  it("inspects a folder under home without making it readable", async () => {
    const found = await call<{ isGit: boolean; path: string }>(w.session, "repos.inspect", {
      path: picked,
    });
    assert.deepEqual({ isGit: found.isGit, path: found.path }, { isGit: true, path: picked });
    await assert.rejects(
      () => w.session.request("fs.list", { path: picked }),
      (err) => err instanceof RpcError && err.code === RPC_PATH_DENIED,
    );
  });

  it("serves a folder after repos.addRoot and keeps it across a restart", async () => {
    await call(w.session, "repos.addRoot", { path: picked });
    assert.ok(await call(w.session, "fs.list", { path: picked }));
    const saved = JSON.parse(readFileSync(join(w.stateDir, "roots.json"), "utf8")) as string[];
    assert.deepEqual(saved, [picked]);

    await w.worker.stop();
    const again = await startWorker(hub, { root: w.root, stateDir: w.stateDir });
    try {
      const info = await call<{ roots: string[] }>(again.session, "host.info", {});
      assert.deepEqual(info.roots, [w.root, picked]);
    } finally {
      await again.worker.stop();
    }
    w = await startWorker(hub, { root: w.root, stateDir: w.stateDir });
  });

  it("clones to the default location, serves it, and records the mapping in its state dir", async () => {
    const result = await call<{ path: string; cloned: boolean }>(w.session, "repos.ensure", {
      remoteUrl: remote,
      defaultBranch: "main",
    });
    assert.equal(result.cloned, true);
    assert.equal(result.path, join(BAND_HOME, "band", "repos", "local", "gizmos"));
    assert.ok(await call(w.session, "fs.list", { path: result.path }));
    const mappings = JSON.parse(readFileSync(join(w.stateDir, "repos.json"), "utf8")) as Record<
      string,
      { path: string }
    >;
    assert.deepEqual(
      Object.values(mappings).map((m) => m.path),
      [result.path],
    );
    const info = await call<{ repoMappings: Array<{ path: string }> }>(w.session, "host.info", {});
    assert.deepEqual(
      info.repoMappings.map((m) => m.path),
      [result.path],
    );
    assert.equal(existsSync(join(result.path, ".git")), true);
  });
});
