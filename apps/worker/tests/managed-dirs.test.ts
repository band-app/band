import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

// The roots here exclude the worker's home, state dir and BAND_HOME, as on a static worker
// whose roots are only the repo folders its user picked.
describe("folders the worker manages itself", () => {
  let hub: TestHub;
  let w: TestWorker;
  let outside: string;
  let reposDir: string;
  const pids = new Set<number>();

  const denied = (method: string, params: unknown) =>
    assert.rejects(
      () => w.session.request(method, params),
      (err) => err instanceof RpcError && err.code === RPC_PATH_DENIED,
      `${method} ${JSON.stringify(params)} should be denied`,
    );

  const message = async (method: string, params: unknown): Promise<string> => {
    try {
      await w.session.request(method, params);
    } catch (err) {
      return (err as Error).message;
    }
    assert.fail(`${method} was not denied`);
  };

  const spawn = async (terminalId: string, cwd: string) => {
    const entry = await call<{ pid: number }>(w.session, "pty.spawn", {
      worktreeId: "ws",
      terminalId,
      worktreeRoot: cwd,
    });
    pids.add(entry.pid);
  };

  before(async () => {
    hub = await startHub();
    reposDir = tmpDir("band-worker-repos-");
    w = await startWorker(hub, { args: ["--repos-dir", reposDir] });
    outside = tmpDir("band-worker-outside-");
    assert.ok(!BAND_HOME.startsWith(w.root), "the roots must not hold the worker's home");
  });
  after(async () => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir, outside, reposDir);
  });

  it("serves the worker's clone directory", async () => {
    const repo = makeRepo(reposDir, "cloned");
    await spawn("repos-term", repo);
    const entries = await call<unknown[]>(w.session, "fs.list", { path: reposDir });
    assert.ok(entries.length > 0);
  });

  it("refuses a sibling folder with no worktree hint for a plain repo", async () => {
    const plain = makeRepo(outside, "plain");
    const text = await message("fs.list", { path: plain });
    assert.match(text, /outside the worker's roots/);
    assert.doesNotMatch(text, /worktree of/);
    await denied("pty.spawn", { worktreeId: "ws", terminalId: "x", worktreeRoot: plain });
  });

  it("names the main repo for a linked worktree of a repo outside the roots", async () => {
    const main = makeRepo(outside, "main-repo");
    const linked = join(outside, "linked");
    git(main, "worktree", "add", "-q", "-b", "feature", linked);
    const text = await message("fs.list", { path: linked });
    assert.match(text, new RegExp(`worktree of ${main.replaceAll("/", "\\/")},`));
  });

  it("refuses a symlink from a managed dir to elsewhere", async () => {
    const secret = join(outside, "secret");
    mkdirSync(secret);
    writeFileSync(join(secret, "key"), "x");
    symlinkSync(secret, join(reposDir, "escape"));
    await denied("fs.readFile", { path: join(reposDir, "escape", "key") });
    await denied("fs.list", { path: join(reposDir, "escape") });
  });

  it("does not treat a sibling with a shared prefix as managed", async () => {
    const sibling = `${reposDir}-evil`;
    mkdirSync(sibling);
    try {
      await denied("fs.list", { path: sibling });
    } finally {
      cleanup(sibling);
    }
  });

  it("refuses to remove a managed directory itself", async () => {
    await denied("fs.rm", { path: reposDir, recursive: true });
  });
});
