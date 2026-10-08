import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { RpcError } from "@band-app/link";
import { RPC_PATH_DENIED } from "../src/rpc-util.ts";
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
} from "./helpers.ts";

// A worktree that git registered for a repo inside a root may live outside the roots.
describe("registered worktrees of a granted repo", () => {
  let hub: TestHub;
  let w: TestWorker;
  let outside: string;
  let repo: string;
  let worktree: string;
  let sibling: string;
  let foreignRepo: string;

  const denied = (method: string, params: unknown) =>
    assert.rejects(
      () => w.session.request(method, params),
      (err) => err instanceof RpcError && err.code === RPC_PATH_DENIED,
      `${method} ${JSON.stringify(params)} should be denied`,
    );

  before(async () => {
    hub = await startHub();
    w = await startWorker(hub);
    outside = tmpDir("band-worker-outside-");
    repo = makeRepo(w.root);
    worktree = join(outside, "feature");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
    writeFileSync(join(worktree, "file.txt"), "hello");
    await call(w.session, "repos.map", { remoteUrl: `file://${repo}`, path: repo });
    sibling = join(outside, "sibling");
    await call(w.session, "fs.mkdir", { path: join(w.root, "scratch") });
    foreignRepo = makeRepo(outside, "foreign");
    git(foreignRepo, "worktree", "add", "-q", "-b", "other", join(outside, "foreign-wt"));
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir, outside);
  });

  it("allows files, git and a terminal in the worktree", async () => {
    const text = await call<Buffer>(w.session, "fs.readFile", { path: join(worktree, "file.txt") });
    assert.equal(text.toString(), "hello");
    const out = await call<{ stdout: string }>(w.session, "git.exec", {
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: worktree,
    });
    assert.match(JSON.stringify(out), /feature/);
    const entry = await call<{ pid: number }>(w.session, "pty.spawn", {
      worktreeId: "ws",
      terminalId: "t-wt",
      worktreeRoot: worktree,
    });
    process.kill(entry.pid, "SIGKILL");
  });

  it("allows a path below the worktree", async () => {
    await call(w.session, "fs.mkdir", { path: join(worktree, "sub") });
  });

  it("still refuses a folder that is not a registered worktree", async () => {
    mkdirSync(sibling);
    await denied("fs.list", { path: sibling });
    await denied("fs.list", { path: outside });
  });

  it("refuses a prefix that only matches as a string", async () => {
    await denied("fs.list", { path: `${worktree}-other` });
  });

  it("refuses a worktree of a repo that is not inside a root, with a hint", async () => {
    await assert.rejects(
      () => w.session.request("fs.list", { path: join(outside, "foreign-wt") }),
      (err) =>
        err instanceof RpcError &&
        err.code === RPC_PATH_DENIED &&
        /not inside a root/.test(err.message),
    );
  });

  it("follows a symlink only to an allowed worktree", async () => {
    symlinkSync(worktree, join(w.root, "scratch", "to-wt"));
    symlinkSync(outside, join(w.root, "scratch", "to-outside"));
    const text = await call<Buffer>(w.session, "fs.readFile", {
      path: join(w.root, "scratch", "to-wt", "file.txt"),
    });
    assert.equal(text.toString(), "hello");
    await denied("fs.list", { path: join(w.root, "scratch", "to-outside") });
  });

  it("refuses the path again after git worktree remove", async () => {
    await call(w.session, "worktree.remove", { repoPath: repo, path: worktree });
    await denied("fs.list", { path: worktree });
  });
});
