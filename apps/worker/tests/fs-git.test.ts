import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { RpcError, type ServerSession } from "@band-app/link";
import { RPC_PATH_DENIED } from "../src/rpc-util.ts";
import {
  call,
  cleanup,
  makeRepo,
  startHub,
  startWorker,
  type TestHub,
  type TestWorker,
  tmpDir,
} from "./helpers.ts";

async function denied(session: ServerSession, method: string, params: unknown): Promise<void> {
  await assert.rejects(
    () => session.request(method, params),
    (err) => err instanceof RpcError && err.code === RPC_PATH_DENIED,
    `${method} ${JSON.stringify(params)} should be denied`,
  );
}

// S2: files and git work inside a root, and nothing reaches outside it.
describe("fs and git inside a root", () => {
  let hub: TestHub;
  let w: TestWorker;
  let outside: string;
  let repo: string;

  before(async () => {
    hub = await startHub();
    w = await startWorker(hub);
    outside = tmpDir("band-worker-outside-");
    writeFileSync(join(outside, "secret.txt"), "top secret");
    repo = makeRepo(w.root);
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir, outside);
  });

  it("writes, reads, stats and lists files", async () => {
    const dir = join(w.root, "docs");
    await call(w.session, "fs.mkdir", { path: dir });
    await call(w.session, "fs.writeFile", { path: join(dir, "a.txt"), data: "hello" });
    await call(w.session, "fs.writeFile", {
      path: join(dir, "b.bin"),
      data: { base64: Buffer.from([1, 2, 3]).toString("base64") },
    });
    const text = await call<Buffer>(w.session, "fs.readFile", { path: join(dir, "a.txt") });
    assert.equal(text.toString(), "hello");
    assert.deepEqual(
      [...(await call<Buffer>(w.session, "fs.readFile", { path: join(dir, "b.bin") }))],
      [1, 2, 3],
    );

    const stat = await call<{ kind: string; size: number }>(w.session, "fs.stat", {
      path: join(dir, "a.txt"),
    });
    assert.deepEqual({ kind: stat.kind, size: stat.size }, { kind: "file", size: 5 });

    const entries = await call<{ name: string; kind: string }[]>(w.session, "fs.list", {
      path: dir,
    });
    assert.deepEqual(entries.map((e) => e.name).sort(), ["a.txt", "b.bin"]);
  });

  it("moves data over the message limit through channels in both directions", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, "abcdefghij");
    const file = join(w.root, "big.bin");
    // The hub opens a channel, writes the data and names the channel in the call.
    const ch = w.session.openChannel("upload");
    const sent = ch.send(big).then(() => ch.end());
    await call(w.session, "fs.writeFile", { path: file, data: { chan: ch.id } });
    await sent;
    assert.equal(readFileSync(file).length, big.length);

    const small = await call<Buffer>(w.session, "fs.readFile", { path: file });
    assert.ok(small.equals(big), "readFile returns every byte through a result channel");

    const { chan } = (await w.session.request("fs.readStream", { path: file })) as { chan: number };
    const stream = w.session.getChannel(chan);
    assert.ok(stream);
    const streamed = await stream.readAll();
    stream.end();
    assert.ok(streamed.equals(big));
  });

  it("reports git status in a repository under the root", async () => {
    writeFileSync(join(repo, "new.txt"), "x");
    const res = await call<{ stdout: string }>(w.session, "git.exec", {
      args: ["status", "--porcelain"],
      cwd: repo,
    });
    assert.equal(res.stdout.trim(), "?? new.txt");
    const wt = await call<{ branch: string }[]>(w.session, "worktree.list", { repoPath: repo });
    assert.equal(wt[0]?.branch, "main");
  });

  it("runs a binary in a directory under the root", async () => {
    const res = await call<{ stdout: string }>(w.session, "exec", {
      bin: process.execPath,
      args: ["-e", "console.log(process.cwd())"],
      options: { cwd: repo },
    });
    assert.equal(res.stdout.trim(), repo);
  });

  it("rejects a path outside every root", async () => {
    await denied(w.session, "fs.readFile", { path: join(outside, "secret.txt") });
    await denied(w.session, "fs.readFile", { path: "/etc/hosts" });
    await denied(w.session, "fs.list", { path: outside });
    await denied(w.session, "git.exec", { args: ["status"], cwd: outside });
    await denied(w.session, "exec", { bin: "ls", args: [], options: { cwd: outside } });
    await denied(w.session, "fs.writeFile", { path: join(outside, "new.txt"), data: "x" });
  });

  it("rejects .. and relative paths", async () => {
    await denied(w.session, "fs.readFile", { path: join(w.root, "..", "secret.txt") });
    await denied(w.session, "fs.readFile", {
      path: `${w.root}/docs/../../${outside.split("/").pop()}/secret.txt`,
    });
    await denied(w.session, "fs.readFile", { path: "secret.txt" });
    await assert.rejects(
      () => w.session.request("fs.glob", { pattern: "../*", cwd: w.root }),
      /pattern must stay/,
    );
  });

  it("rejects a symlink that points outside, for reads, writes and listings", async () => {
    symlinkSync(join(outside, "secret.txt"), join(w.root, "file-link"));
    symlinkSync(outside, join(w.root, "dir-link"));
    await denied(w.session, "fs.readFile", { path: join(w.root, "file-link") });
    await denied(w.session, "fs.readFile", { path: join(w.root, "dir-link", "secret.txt") });
    await denied(w.session, "fs.list", { path: join(w.root, "dir-link") });
    await denied(w.session, "fs.writeFile", {
      path: join(w.root, "dir-link", "new.txt"),
      data: "x",
    });
    await denied(w.session, "fs.stat", { path: join(w.root, "file-link"), followSymlinks: true });
    await denied(w.session, "git.exec", { args: ["status"], cwd: join(w.root, "dir-link") });
    assert.ok(!existsSync(join(outside, "new.txt")));
  });

  it("rejects a brace glob that climbs out of the root", async () => {
    await assert.rejects(
      () => w.session.request("fs.glob", { pattern: "{..,x}/*", cwd: w.root }),
      /pattern must stay/,
    );
  });

  it("refuses a recursive copy of a tree holding a link that leaves the root", async () => {
    const src = join(w.root, "copy-src");
    await call(w.session, "fs.mkdir", { path: src });
    symlinkSync(join(outside, "secret.txt"), join(src, "inner-link"));
    await denied(w.session, "fs.copy", {
      from: src,
      to: join(w.root, "copy-dst"),
      recursive: true,
    });
    assert.ok(!existsSync(join(w.root, "copy-dst")));
  });

  it("rejects a write through a dangling symlink", async () => {
    symlinkSync(join(outside, "created-by-write.txt"), join(w.root, "dangling"));
    await denied(w.session, "fs.writeFile", { path: join(w.root, "dangling"), data: "x" });
    assert.ok(!existsSync(join(outside, "created-by-write.txt")));
  });

  it("acts on a symlink itself when the call does not follow it", async () => {
    symlinkSync(outside, join(w.root, "removable"));
    const stat = await call<{ kind: string }>(w.session, "fs.stat", {
      path: join(w.root, "removable"),
    });
    assert.equal(stat.kind, "symlink");
    await call(w.session, "fs.rm", { path: join(w.root, "removable") });
    assert.ok(!existsSync(join(w.root, "removable")));
    assert.ok(existsSync(join(outside, "secret.txt")), "the target outside the root is untouched");
  });

  it("does not let a root be removed or moved", async () => {
    await denied(w.session, "fs.rm", { path: w.root, recursive: true });
    await denied(w.session, "fs.rename", { from: join(w.root, "docs"), to: join(outside, "docs") });
  });

  it("allows the private temp dir it makes", async () => {
    const dir = await call<string>(w.session, "fs.mkdtemp", { prefix: "worker-test-" });
    await call(w.session, "fs.writeFile", { path: join(dir, "t.txt"), data: "ok" });
    await call(w.session, "fs.rm", { path: dir, recursive: true });
    await assert.rejects(() => w.session.request("fs.mkdtemp", { prefix: "../x" }), /separator/);
  });

  it("creates a worktree inside the root and refuses one outside", async () => {
    const wtPath = join(w.root, "wt-feature");
    await call(w.session, "worktree.create", { repoPath: repo, path: wtPath, branch: "feature" });
    assert.ok(existsSync(join(wtPath, ".git")));
    await denied(w.session, "worktree.create", {
      repoPath: repo,
      path: join(outside, "wt"),
      branch: "elsewhere",
    });
  });
});
