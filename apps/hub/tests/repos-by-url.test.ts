// Integration tests for repos defined by remote URL (worker-owned clone mapping). A real hub
// (production bundle, temp BAND_HOME, BAND_LOCAL_HOST=off so it holds no checkout of its own)
// and a real `band-worker` process with its own temp HOME. Remotes are local bare repos.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "repos-by-url-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface RepoView {
  name: string;
  path: string;
  remoteUrl?: string;
  defaultBranch: string;
  clones: Array<{ hostId: string; path: string }>;
  worktrees: Array<{ name: string; path: string; hostId?: string }>;
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

/** A bare repo with one commit on main, standing in for a remote. */
function makeRemote(parent: string, name: string): string {
  const seed = join(parent, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), `hello from ${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  const bare = join(parent, `${name}.git`);
  git(parent, "clone", "-q", "--bare", seed, bare);
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  return bare;
}

let server: ServerHandle;
let workerHome: string;
let workerRoot: string;
let workerState: string;
let worker: ChildProcess;
let hostId: string;
let remotes: string;

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const repo = async (name: string) =>
  (await q<{ repos: RepoView[] }>("repos.list")).repos.find((r) => r.name === name);

beforeAll(async () => {
  const hubHome = createTmpHome("band-repos-url-hub-");
  scratch.push(hubHome);
  workerHome = tmp("band-repos-url-whome-");
  workerRoot = tmp("band-repos-url-root-");
  workerState = tmp("band-repos-url-state-");
  remotes = tmp("band-repos-url-remotes-");
  seedSettings(hubHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_LOCAL_HOST: "off", BAND_SERVE_UI: "false" },
  });

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "W",
  });
  hostId = issued.hostId;
  worker = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      workerRoot,
      "--state-dir",
      workerState,
    ],
    {
      env: { ...process.env, HOME: workerHome, BAND_HOME: join(workerHome, ".band") },
      stdio: "ignore",
    },
  );
  await waitFor(
    async () =>
      (await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
        (h) => h.id === hostId,
      )?.status === "online"
        ? true
        : undefined,
    { label: "worker online", timeoutMs: 20_000 },
  );
}, 120_000);

afterAll(async () => {
  worker?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

const checkoutOfProj = () => join(workerHome, "code", "proj");

describe("adding a repo from a worker (S1)", () => {
  const checkoutOf = checkoutOfProj;

  it("stores the URL and default branch the worker read, and holds no hub path", async () => {
    const remote = makeRemote(remotes, "proj");
    mkdirSync(join(workerHome, "code"), { recursive: true });
    git(join(workerHome, "code"), "clone", "-q", remote, "proj");

    // The checkout is under the worker's home but outside its roots, so the hub asks first.
    const refused = await trpcMutate(
      server.url,
      "repos.addFromWorker",
      { hostId, path: checkoutOf() },
      TOKEN,
    );
    expect(refused.status).toBe(412);
    expect(JSON.stringify(await refused.json())).toContain("OUTSIDE_ROOTS");
    expect(await repo("proj")).toBeUndefined();

    await m("repos.addFromWorker", { hostId, path: checkoutOf(), addRoot: true });
    const added = await repo("proj");
    expect(added).toMatchObject({
      name: "proj",
      path: "",
      remoteUrl: remote,
      defaultBranch: "main",
    });
    expect(added?.clones).toEqual([{ hostId, path: checkoutOf() }]);
  });

  it("creates a worktree in the existing folder and never clones", async () => {
    const created = await m<{ path: string }>("worktrees.create", {
      repo: "proj",
      branch: "feat-a",
      hostId,
    });
    expect(created.path).toBe(join(workerRoot, ".band-worktrees", "proj", "feat-a"));
    // The worktree belongs to the picked checkout, and the default clone location was not made.
    const common = git(
      created.path,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ).trim();
    expect(common).toBe(join(checkoutOf(), ".git"));
    expect(existsSync(join(workerHome, "band", "repos"))).toBe(false);
  });

  it("keeps the folder in the worker's own mapping", async () => {
    const mappings = JSON.parse(readFileSync(join(workerState, "repos.json"), "utf8")) as Record<
      string,
      { path: string }
    >;
    expect(Object.values(mappings).map((e) => e.path)).toEqual([checkoutOf()]);
  });
});

describe("a repo added by URL (S2)", () => {
  it("clones on first use, records the mapping, and reuses it", async () => {
    const remote = makeRemote(remotes, "other");
    await m("repos.addByUrl", { remoteUrl: remote });
    const added = await repo("other");
    // The default branch came from the remote through a worker, and the hub holds no path.
    expect(added).toMatchObject({ path: "", remoteUrl: remote, defaultBranch: "main", clones: [] });

    const clone = join(workerHome, "band", "repos", "local", "other");
    expect(existsSync(clone)).toBe(false);
    await m("worktrees.create", { repo: "other", branch: "first", hostId });
    expect(existsSync(join(clone, "hello.txt"))).toBe(true);
    expect((await repo("other"))?.clones).toEqual([{ hostId, path: clone }]);
    const mapping = JSON.parse(readFileSync(join(workerState, "repos.json"), "utf8")) as Record<
      string,
      { path: string }
    >;
    expect(Object.values(mapping).map((e) => e.path)).toContain(clone);

    // A marker in the clone survives the next worktree, so the folder was reused.
    writeFileSync(join(clone, "marker.txt"), "still here\n");
    await m("worktrees.create", { repo: "other", branch: "second", hostId });
    expect(readFileSync(join(clone, "marker.txt"), "utf8")).toBe("still here\n");
    expect(git(clone, "worktree", "list")).toContain("second");
  });

  it("refuses a second repo with the same remote under another spelling", async () => {
    const res = await trpcMutate(
      server.url,
      "repos.addByUrl",
      { remoteUrl: `file://${join(remotes, "other.git")}`, defaultBranch: "main" },
      TOKEN,
    );
    expect(res.status).toBe(409);
  });

  it("strips credentials from a stored URL", async () => {
    await m("repos.addByUrl", {
      remoteUrl: "https://user:s3cret@example.com/acme/app.git",
      defaultBranch: "main",
    });
    const added = await repo("app");
    expect(added?.remoteUrl).toBe("https://example.com/acme/app.git");
    expect(JSON.stringify(await q("repos.list"))).not.toContain("s3cret");
  });

  it("says a repo with no remote lives on one host only", async () => {
    const lone = join(workerRoot, "lone");
    mkdirSync(lone, { recursive: true });
    git(lone, "init", "-q", "-b", "main");
    writeFileSync(join(lone, "a.txt"), "a\n");
    git(lone, "add", ".");
    git(lone, "commit", "-q", "-m", "init");
    await m("repos.addFromWorker", { hostId, path: lone });
    expect((await repo("lone"))?.remoteUrl).toBeUndefined();
    const created = await m<{ path: string }>("worktrees.create", {
      repo: "lone",
      branch: "on-holder",
      hostId,
    });
    expect(created.path).toContain("on-holder");

    // No host that holds it fits the placement, and a runner could not clone it either.
    const refused = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: "lone", branch: "nowhere", placement: { labels: { pool: "none" } } },
      TOKEN,
    );
    expect(refused.status).toBe(500);
    expect(JSON.stringify(await refused.json())).toContain("no remote URL");
  });
});

describe("previewing a repo before adding it", () => {
  interface FolderPreview {
    path: string;
    isGit: boolean;
    remoteUrl: string | null;
    defaultBranch: string | null;
    name: string;
    cloneable: boolean;
    insideRoots: boolean;
    roots: string[];
    existingRepo: string | null;
  }

  it("reads a worker folder's remote and branch without adding it", async () => {
    const remote = makeRemote(remotes, "peek");
    git(workerRoot, "clone", "-q", remote, "peek");
    const preview = await q<FolderPreview>("repos.inspectFolder", {
      hostId,
      path: join(workerRoot, "peek"),
    });
    expect(preview).toMatchObject({
      path: join(workerRoot, "peek"),
      isGit: true,
      remoteUrl: remote,
      defaultBranch: "main",
      name: "peek",
      cloneable: true,
      insideRoots: true,
      existingRepo: null,
    });
    expect(await repo("peek")).toBeUndefined();
  });

  it("names the repo that already uses the folder's remote", async () => {
    const preview = await q<FolderPreview>("repos.inspectFolder", {
      hostId,
      path: checkoutOfProj(),
    });
    expect(preview.existingRepo).toBe("proj");
  });

  it("reports a folder with no remote and one outside the roots", async () => {
    const plain = join(workerHome, "loose");
    mkdirSync(plain, { recursive: true });
    const preview = await q<FolderPreview>("repos.inspectFolder", { hostId, path: plain });
    expect(preview).toMatchObject({ isGit: false, remoteUrl: null, insideRoots: false });
    expect(preview.roots).toContain(workerRoot);
  });

  it("answers 400 for an unknown host and for a URL that is not a git remote", async () => {
    const host = await trpcQuery(
      server.url,
      "repos.inspectFolder",
      { hostId: "h-nope", path: workerRoot },
      TOKEN,
    );
    expect(host.status).toBe(400);
    const url = await trpcQuery(
      server.url,
      "repos.resolveRemote",
      { remoteUrl: "not a url" },
      TOKEN,
    );
    expect(url.status).toBe(400);
  });

  it("resolves a URL's default branch without adding it", async () => {
    const remote = makeRemote(remotes, "resolved");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
    git(remote, "branch", "trunk", "main");
    const preview = await q<{ url: string; name: string; defaultBranch: string }>(
      "repos.resolveRemote",
      { remoteUrl: remote },
    );
    expect(preview).toEqual({ url: remote, name: "resolved", defaultBranch: "trunk" });
    expect(await repo("resolved")).toBeUndefined();
  });

  it("refuses a URL a repo already uses and a non-admin token", async () => {
    const dup = await trpcQuery(
      server.url,
      "repos.resolveRemote",
      { remoteUrl: join(remotes, "other.git") },
      TOKEN,
    );
    expect(dup.status).toBe(409);
    const device = await m<{ token: string }>("tokens.createDevice", { label: "peek" });
    const res = await trpcQuery(
      server.url,
      "repos.inspectFolder",
      { hostId, path: workerRoot },
      device.token,
    );
    expect(res.status).toBe(403);
    const resolve = await trpcQuery(
      server.url,
      "repos.resolveRemote",
      { remoteUrl: "https://example.com/acme/peek.git" },
      device.token,
    );
    expect(resolve.status).toBe(403);
    const anon = await trpcQuery(
      server.url,
      "repos.resolveRemote",
      { remoteUrl: "https://example.com/acme/peek.git" },
      "",
    );
    expect(anon.status).toBe(401);
  });
});

describe("who may add repos by URL", () => {
  it("refuses a request with no token and a non-admin device token", async () => {
    const body = { remoteUrl: "https://example.com/acme/guarded.git", defaultBranch: "main" };
    const anon = await fetch(`${server.url}/trpc/repos.addByUrl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(anon.status).toBe(401);
    const device = await m<{ token: string }>("tokens.createDevice", { label: "plain" });
    const plain = await trpcMutate(server.url, "repos.addByUrl", body, device.token);
    expect(plain.status).toBe(403);
    const browse = await trpcQuery(server.url, "hosts.browse", { hostId }, device.token);
    expect(browse.status).toBe(403);
  });

  it("refuses a URL whose path climbs out of the clone folder", async () => {
    const res = await trpcMutate(
      server.url,
      "repos.addByUrl",
      { remoteUrl: "git@example.com:../../escape/x", defaultBranch: "main" },
      TOKEN,
    );
    expect(res.status).toBe(400);
  });
});

describe("runner hooks on a hub with no checkout (S6)", () => {
  it("passes the stored URL as BAND_REPO_URLS", async () => {
    await m("repos.addByUrl", {
      remoteUrl: "https://user:s3cret@example.com/acme/app.git",
      defaultBranch: "main",
    }).catch(() => undefined);
    const marks = tmp("band-repos-url-marks-");
    const hook = join(marks, "spawn.sh");
    writeFileSync(
      hook,
      `#!/bin/sh\nenv > "${join(marks, "env.tmp")}" && mv "${join(marks, "env.tmp")}" "${join(marks, "env")}"\nexit 1\n`,
    );
    chmodSync(hook, 0o755);
    await m("settings.update", {
      runners: [{ id: "fake", spawn: hook, labels: { pool: "fake" }, timeoutSec: 20 }],
    });
    const res = await m<{ provisioning?: { requestId: string } }>("worktrees.create", {
      repo: "app",
      branch: "via-runner",
      placement: { labels: { pool: "fake" } },
    });
    expect(res.provisioning?.requestId).toBeTruthy();
    const env = await waitFor(
      async () =>
        existsSync(join(marks, "env")) ? readFileSync(join(marks, "env"), "utf8") : undefined,
      { label: "hook ran", timeoutMs: 30_000, intervalMs: 250 },
    );
    expect(env).toContain("BAND_REPO_URLS=https://example.com/acme/app.git\n");
    expect(env).not.toContain("s3cret");
  });
});
