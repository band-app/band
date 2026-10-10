// Integration test for origin links and meta repos on the hub's own machine (plan section 15, step O.2). A real
// hub (the production bundle on a random port, temp BAND_HOME) with two git repos. The worker-side paths, where the
// origin comes from a chat or terminal identity, are in `origin-links-relay.test.ts`.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "origin-links-secret";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

interface Listed {
  repos: Array<{
    name: string;
    meta: boolean;
    worktrees: Array<{
      worktreeId: string;
      origin: { worktreeId: string; removed: boolean; repo?: string; branch?: string } | null;
      children: string[];
    }>;
  }>;
}

let server: ServerHandle;

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const list = () =>
  trpcQuery(server.url, "repos.list", undefined, TOKEN).then((res) => trpcData<Listed>(res));
const worktree = async (id: string) =>
  (await list()).repos.flatMap((r) => r.worktrees).find((w) => w.worktreeId === id);

beforeAll(async () => {
  const home = createTmpHome("band-origin-local-");
  scratch.push(home);
  const borko = join(tmp("band-origin-borko-"), "borko");
  const svc = join(tmp("band-origin-svc-"), "svc");
  makeRepo(borko);
  makeRepo(svc);
  seedSettings(home, { tokenSecret: TOKEN });
  seedState(home, {
    repos: [
      {
        name: "borko",
        path: borko,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: borko }],
      },
      {
        name: "svc",
        path: svc,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: svc }],
      },
    ],
  });
  server = await startServer({ tmpHome: home, env: { BAND_SERVE_UI: "false" } });
}, 120_000);

afterAll(async () => {
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("auth", () => {
  it("refuses the new mutations without a token", async () => {
    for (const [procedure, body] of [
      ["repos.update", { name: "borko", meta: true }],
      ["worktrees.create", { repo: "svc", branch: "no-token", origin: "borko-main" }],
    ] as const) {
      const res = await fetch(`${server.url}/trpc/${procedure}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(401);
    }
  });
});

describe("meta repos (S5)", () => {
  it("persists the flag, returns it from repos.list, and keeps it when the repo list is rewritten", async () => {
    expect((await list()).repos.map((r) => [r.name, r.meta])).toEqual([
      ["borko", false],
      ["svc", false],
    ]);
    await m("repos.update", { name: "borko", meta: true });
    expect((await list()).repos.find((r) => r.name === "borko")?.meta).toBe(true);

    // `repos.reorder` and `worktrees.create` rewrite the whole repo tree. The flag survives both.
    await m("repos.reorder", { names: ["svc", "borko"] });
    await m("worktrees.create", { repo: "svc", branch: "meta-check" });
    const after = (await list()).repos;
    expect(after.map((r) => [r.name, r.meta])).toEqual([
      ["svc", false],
      ["borko", true],
    ]);

    await m("repos.update", { name: "borko", meta: false });
    expect((await list()).repos.find((r) => r.name === "borko")?.meta).toBe(false);
  });

  it("refuses an unknown repo", async () => {
    const res = await trpcMutate(server.url, "repos.update", { name: "nope", meta: true }, TOKEN);
    expect(res.status).toBe(400);
  });
});

describe("explicit origins", () => {
  it("links a worktree to the one it names, across repos, and lists the children (S3)", async () => {
    await m("worktrees.create", { repo: "borko", branch: "root" });
    await m("worktrees.create", { repo: "svc", branch: "middle", origin: "borko-root" });
    await m("worktrees.create", { repo: "borko", branch: "leaf", origin: "svc-middle" });
    await m("worktrees.create", { repo: "svc", branch: "free", origin: "borko-root" });

    expect((await worktree("borko-root"))?.origin).toBeNull();
    expect(await worktree("svc-middle")).toMatchObject({
      origin: { worktreeId: "borko-root", removed: false, repo: "borko", branch: "root" },
      children: ["borko-leaf"],
    });
    expect((await worktree("borko-leaf"))?.origin).toMatchObject({ worktreeId: "svc-middle" });
    expect((await worktree("borko-root"))?.children.sort()).toEqual(["svc-free", "svc-middle"]);
  });

  it("keeps the origin when the repo list is rewritten", async () => {
    await m("repos.reorder", { names: ["borko", "svc"] });
    expect((await worktree("borko-leaf"))?.origin).toMatchObject({ worktreeId: "svc-middle" });
  });

  it("starts with no origin for noOrigin, and refuses both options or an unknown parent", async () => {
    await m("worktrees.create", { repo: "svc", branch: "alone", noOrigin: true });
    expect((await worktree("svc-alone"))?.origin).toBeNull();

    const both = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: "svc", branch: "both", origin: "borko-root", noOrigin: true },
      TOKEN,
    );
    expect(both.status).toBe(500);
    expect(await both.text()).toContain("either origin or noOrigin");

    const unknown = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: "svc", branch: "ghost-parent", origin: "borko-missing" },
      TOKEN,
    );
    expect(unknown.status).toBe(500);
    expect(await unknown.text()).toContain("Unknown origin worktree");
    expect(await worktree("svc-ghost-parent")).toBeUndefined();
  });

  it("reports the origin as removed once the parent is deleted, and keeps the child (S4)", async () => {
    await m("worktrees.remove", { repo: "svc", name: "middle" });
    expect(await worktree("svc-middle")).toBeUndefined();
    const orphan = await worktree("borko-leaf");
    expect(orphan?.origin).toEqual({ worktreeId: "svc-middle", removed: true });
    expect((await worktree("borko-root"))?.children).toEqual(["svc-free"]);
  });
});
