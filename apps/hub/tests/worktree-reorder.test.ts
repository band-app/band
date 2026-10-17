// Integration test for `worktrees.reorder`: the shared sort index, the Pinned section's own order, and
// the reparent that a drop in the Origin view makes in the same call. A real hub on a random port with a
// temp BAND_HOME and one git repo.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "worktree-reorder-secret";

const scratch: string[] = [];

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
    worktrees: Array<{
      worktreeId: string;
      name: string;
      sortIndex?: number;
      pinSortIndex?: number;
      origin: { worktreeId: string } | null;
    }>;
  }>;
}

let server: ServerHandle;

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const worktrees = async () =>
  (await trpcQuery(server.url, "repos.list", undefined, TOKEN).then((res) => trpcData<Listed>(res)))
    .repos[0].worktrees;
const byName = async (name: string) => (await worktrees()).find((w) => w.name === name);

beforeAll(async () => {
  const home = createTmpHome("band-reorder-");
  scratch.push(home);
  const base = realpathSync(mkdtempSync(join(tmpdir(), "band-reorder-repo-")));
  scratch.push(base);
  const svc = join(base, "svc");
  makeRepo(svc);
  seedSettings(home, { tokenSecret: TOKEN });
  seedState(home, {
    repos: [
      {
        name: "svc",
        path: svc,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: svc }],
      },
    ],
  });
  server = await startServer({ tmpHome: home, env: { BAND_SERVE_UI: "false" } });
  for (const branch of ["a", "b", "c"]) await m("worktrees.create", { repo: "svc", branch });
}, 120_000);

afterAll(async () => {
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("worktrees.reorder", () => {
  it("leaves the sort index unset until a list is reordered", async () => {
    expect((await byName("a"))?.sortIndex).toBeUndefined();
  });

  it("stores the positions of the list and keeps them when the repo list is rewritten", async () => {
    await m("worktrees.reorder", {
      scope: "siblings",
      order: ["c", "a", "b"].map((name) => ({ repo: "svc", name })),
    });
    const indexOf = async (name: string) => (await byName(name))?.sortIndex;
    expect([await indexOf("c"), await indexOf("a"), await indexOf("b")]).toEqual([0, 1, 2]);

    await m("repos.reorder", { names: ["svc"] });
    expect([await indexOf("c"), await indexOf("a"), await indexOf("b")]).toEqual([0, 1, 2]);
  });

  it("keeps the Pinned order apart from the sibling order", async () => {
    await m("worktrees.reorder", {
      scope: "pins",
      order: ["b", "a"].map((name) => ({ repo: "svc", name })),
    });
    expect((await byName("b"))?.pinSortIndex).toBe(0);
    expect((await byName("a"))?.pinSortIndex).toBe(1);
    expect((await byName("a"))?.sortIndex).toBe(1);
  });

  it("changes the parent in the same call", async () => {
    await m("worktrees.reorder", {
      scope: "siblings",
      order: [{ repo: "svc", name: "b" }],
      reparent: { repo: "svc", name: "b", origin: "svc-a" },
    });
    expect((await byName("b"))?.origin).toMatchObject({ worktreeId: "svc-a" });
  });

  it("refuses a parent that is a descendant and changes nothing", async () => {
    const before = (await byName("a"))?.sortIndex;
    const res = await trpcMutate(
      server.url,
      "worktrees.reorder",
      {
        scope: "siblings",
        order: [{ repo: "svc", name: "a" }],
        reparent: { repo: "svc", name: "a", origin: "svc-b" },
      },
      TOKEN,
    );
    expect(res.status).not.toBe(200);
    expect((await byName("a"))?.origin).toBeNull();
    expect((await byName("a"))?.sortIndex).toBe(before);
  });

  it("refuses a call without a token and changes nothing", async () => {
    const before = (await byName("c"))?.sortIndex;
    const res = await fetch(`${server.url}/trpc/worktrees.reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "siblings", order: [{ repo: "svc", name: "c" }] }),
    });
    expect(res.status).toBe(401);
    expect((await byName("c"))?.sortIndex).toBe(before);
  });

  it("changes nothing when a later ref in the order is unknown", async () => {
    const before = (await byName("a"))?.origin;
    const res = await trpcMutate(
      server.url,
      "worktrees.reorder",
      {
        scope: "siblings",
        order: [
          { repo: "svc", name: "a" },
          { repo: "svc", name: "ghost" },
        ],
        reparent: { repo: "svc", name: "a", origin: "svc-c" },
      },
      TOKEN,
    );
    expect(res.status).not.toBe(200);
    expect((await byName("a"))?.origin ?? null).toEqual(before ?? null);
  });

  it("refuses an unknown worktree", async () => {
    const res = await trpcMutate(
      server.url,
      "worktrees.reorder",
      { scope: "siblings", order: [{ repo: "svc", name: "ghost" }] },
      TOKEN,
    );
    expect(res.status).not.toBe(200);
  });
});
