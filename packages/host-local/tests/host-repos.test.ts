import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { LocalRepos } from "../src/repos/host-repos";

// Real git and real folders in a temp dir. The mapping file and the clone location are the
// temp dir's, never the user's home.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

describe("LocalRepos", () => {
  let dir: string;
  let remote: string;
  let repos: LocalRepos;
  let reposDir: string;
  let mappingsFile: string;

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "band-local-repos-")));
    const seed = join(dir, "seed");
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "trunk");
    writeFileSync(join(seed, "a.txt"), "a\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "init");
    remote = join(dir, "widgets.git");
    git(dir, "clone", "-q", "--bare", seed, remote);
    git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
    reposDir = join(dir, "clones");
    mappingsFile = join(dir, "state", "repos.json");
    repos = new LocalRepos({ mappingsFile: () => mappingsFile, reposDir: () => reposDir });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the origin URL and the default branch of a checkout, without credentials", async () => {
    const checkout = join(dir, "checkout");
    git(dir, "clone", "-q", remote, checkout);
    git(checkout, "remote", "set-url", "origin", "https://user:tok@example.com/acme/widgets.git");
    const found = await repos.inspect(checkout);
    assert.equal(found.isGit, true);
    assert.equal(found.remoteUrl, "https://example.com/acme/widgets.git");
    assert.equal(found.path, checkout);
  });

  it("falls back to the current branch when origin/HEAD is not set", async () => {
    const lone = join(dir, "lone");
    mkdirSync(lone);
    git(lone, "init", "-q", "-b", "develop");
    assert.deepEqual(await repos.inspect(lone), {
      path: lone,
      isGit: true,
      remoteUrl: null,
      defaultBranch: "develop",
    });
  });

  it("clones to <reposDir>/<owner>/<name> once and then reuses the mapping", async () => {
    const first = await repos.ensure({ remoteUrl: remote, defaultBranch: "trunk" });
    assert.equal(first.cloned, true);
    assert.equal(first.path, join(reposDir, "local", "widgets"));
    assert.equal(existsSync(join(first.path, "a.txt")), true);

    writeFileSync(join(first.path, "marker"), "kept\n");
    const second = await repos.ensure({ remoteUrl: `file://${remote}`, defaultBranch: "trunk" });
    assert.deepEqual(second, { path: first.path, cloned: false });
    assert.equal(existsSync(join(first.path, "marker")), true);
  });

  it("shares one clone between concurrent calls", async () => {
    const other = join(dir, "gadgets.git");
    git(dir, "clone", "-q", "--bare", remote, other);
    const [a, b] = await Promise.all([
      repos.ensure({ remoteUrl: other, defaultBranch: "trunk" }),
      repos.ensure({ remoteUrl: other, defaultBranch: "trunk" }),
    ]);
    // Both callers get the answer of the one clone that ran.
    assert.deepEqual(a, b);
    assert.equal(a.cloned, true);
  });

  it("uses a folder that was mapped by hand and survives a new instance", async () => {
    const mapped = join(dir, "elsewhere");
    git(dir, "clone", "-q", remote, mapped);
    await repos.map("https://github.com/acme/sprockets.git", mapped);
    const again = new LocalRepos({ mappingsFile: () => mappingsFile, reposDir: () => reposDir });
    const result = await again.ensure({
      remoteUrl: "git@github.com:acme/sprockets",
      defaultBranch: "main",
    });
    assert.deepEqual(result, { path: mapped, cloned: false });
    assert.equal(existsSync(join(reposDir, "acme")), false);
  });

  it("clones again when the mapped folder is gone", async () => {
    const gone = join(dir, "vanishing");
    git(dir, "clone", "-q", remote, gone);
    await repos.map(remote.replace("widgets", "vanishing-remote"), gone);
    rmSync(gone, { recursive: true, force: true });
    // The remote it maps does not exist, so the clone fails with a message naming the URL.
    await assert.rejects(
      repos.ensure({
        remoteUrl: remote.replace("widgets", "vanishing-remote"),
        defaultBranch: "trunk",
      }),
      /git clone .* failed/,
    );
  });

  it("refuses text that is not a remote", async () => {
    await assert.rejects(
      repos.ensure({ remoteUrl: "nope", defaultBranch: "main" }),
      /not a git remote URL/,
    );
  });

  it("does not put credentials in a failure", async () => {
    await assert.rejects(
      repos.ensure({
        remoteUrl: "https://user:s3cret@127.0.0.1:9/acme/none.git",
        defaultBranch: "main",
      }),
      (err: Error) => !err.message.includes("s3cret"),
    );
  });
});
