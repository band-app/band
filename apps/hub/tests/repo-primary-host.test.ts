// Integration test for which host lists a repo's default-branch worktree, and for the flag on
// worktrees whose host is no longer allowed. A real hub (production bundle, temp BAND_HOME) with a
// repo that has a checkout on the hub and on two worker hosts. The workers are rows in the hosts
// table only: listing never needs them online, and a worktree on the hub's own machine proves a
// flagged worktree still opens.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toWorktreeId } from "@band-app/shared/worktree-id";
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
import { isRemoteLoopback, LOOPBACK_HOST_ID, testWorktreeId } from "./helpers/test-host";

const TOKEN = "repo-primary-host-secret";

// The hub's own machine plays one host. With `BAND_TEST_HOST=remote-loopback` the harness moves
// every seeded worktree onto the loopback worker, so that worker is the "hub" host here and its
// id is not "local". The two worker hosts are rows in the hosts table that no process serves.
const HUB_HOST = isRemoteLoopback ? LOOPBACK_HOST_ID : "local";
// With no primary chosen, the hub's own machine lists the default branch when it holds one;
// otherwise the lowest host id does, and "h-a" sorts before the loopback worker.
const DEFAULT_PRIMARY = isRemoteLoopback ? "h-a" : "local";

interface Listed {
  repos: Array<{
    name: string;
    allowedHostIds: string[] | null;
    primaryHostId: string | null;
    worktrees: Array<{ worktreeId: string; hostNotAllowed?: boolean }>;
  }>;
}

const scratch: string[] = [];
let server: ServerHandle;
let repoDir: string;
let featureDir: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
const m = (procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<unknown>(res);
  });
const multi = async () => {
  const res = await trpcQuery(server.url, "repos.list", undefined, TOKEN);
  const found = (await trpcData<Listed>(res)).repos.find((r) => r.name === "multi");
  if (!found) throw new Error("multi is not listed");
  return found;
};
const listedIds = async () => (await multi()).worktrees.map((w) => w.worktreeId).sort();

beforeAll(async () => {
  const home = createTmpHome("band-primary-host-");
  scratch.push(home);
  const base = realpathSync(mkdtempSync(join(tmpdir(), "band-primary-host-repo-")));
  scratch.push(base);
  repoDir = join(base, "multi");
  featureDir = join(base, "multi-feat");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  writeFileSync(join(repoDir, "hello.txt"), "hello\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", "init");
  git(repoDir, "worktree", "add", "-q", "-b", "feat-local", featureDir);

  seedSettings(home, { tokenSecret: TOKEN });
  seedState(home, {
    hosts: [
      { id: "h-a", name: "Alpha" },
      { id: "h-b", name: "Bravo" },
    ],
    repos: [
      {
        name: "multi",
        path: repoDir,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: repoDir },
          { branch: "feat-local", path: featureDir },
        ],
      },
    ],
  });
  server = await startServer({ tmpHome: home });
  // The worker hosts' rows go in after the start: the loopback harness moves every row seeded
  // before it onto its one worker, which would put all three hosts' rows on the same host.
  const sqlite = new DatabaseSync(join(home, ".band", "band.db"));
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    const insert = sqlite.prepare(
      "INSERT INTO worktrees (repo_name, name, branch, path, host_id) VALUES ('multi', ?, ?, ?, ?)",
    );
    insert.run("main", "main", "/srv/alpha/multi", "h-a");
    insert.run("main", "main", "/srv/bravo/multi", "h-b");
    insert.run("feat-b", "feat-b", "/srv/bravo/wt/feat-b", "h-b");
  } finally {
    sqlite.close();
  }
}, 60_000);

afterAll(async () => {
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

const idOn = (branch: string, hostId: string) => toWorktreeId("multi", branch, hostId);
const hubFeature = testWorktreeId("multi", "feat-local");

describe("the primary host lists the default branch (S4)", () => {
  it("lists one default-branch worktree: the hub's own when it holds one, before a primary is chosen", async () => {
    expect(await listedIds()).toEqual(
      [idOn("feat-b", "h-b"), hubFeature, idOn("main", DEFAULT_PRIMARY)].sort(),
    );
    expect((await multi()).primaryHostId).toBe(DEFAULT_PRIMARY);
  });

  it("switches the listed default branch when the primary changes, and moves nothing", async () => {
    await m("repos.update", { name: "multi", primaryHostId: "h-b" });
    expect(await listedIds()).toEqual(
      [idOn("feat-b", "h-b"), hubFeature, idOn("main", "h-b")].sort(),
    );
    expect((await multi()).primaryHostId).toBe("h-b");

    // A worker host as the primary works the same as the hub's own machine.
    await m("repos.update", { name: "multi", primaryHostId: "h-a" });
    expect(await listedIds()).toEqual(
      [idOn("feat-b", "h-b"), hubFeature, idOn("main", "h-a")].sort(),
    );

    // The hub's own machine can be the primary too.
    await m("repos.update", { name: "multi", primaryHostId: HUB_HOST });
    expect(await listedIds()).toEqual(
      [idOn("feat-b", "h-b"), hubFeature, idOn("main", HUB_HOST)].sort(),
    );

    // Nothing moved on disk: the hub's checkout and its worktree are where they were.
    expect(existsSync(join(repoDir, "hello.txt"))).toBe(true);
    expect(existsSync(featureDir)).toBe(true);
  });

  it("lets the hub pick again when the primary is cleared", async () => {
    await m("repos.update", { name: "multi", primaryHostId: null });
    expect((await multi()).primaryHostId).toBe(DEFAULT_PRIMARY);
    expect(await listedIds()).toContain(idOn("main", DEFAULT_PRIMARY));
  });
});

describe("a worktree whose host is no longer allowed (S5)", () => {
  it("is flagged, still resolves, and keeps its files", async () => {
    await m("repos.update", { name: "multi", allowedHostIds: ["h-a", "h-b"] });
    const repo = await multi();
    expect(repo.allowedHostIds).toEqual(["h-a", "h-b"]);

    const flagged = repo.worktrees.filter((w) => w.hostNotAllowed).map((w) => w.worktreeId);
    expect(flagged).toEqual([hubFeature]);
    // The primary moved off the hub, which the repo may no longer use.
    expect(repo.primaryHostId).toBe("h-a");
    expect(repo.worktrees.find((w) => w.worktreeId === idOn("feat-b", "h-b"))?.hostNotAllowed).toBe(
      undefined,
    );

    // The flagged worktree still opens: git answers on it, and its folder is untouched.
    const res = await trpcQuery(
      server.url,
      "worktree.getChanges",
      { worktreeId: hubFeature },
      TOKEN,
    );
    expect(res.status).toBe(200);
    expect((await trpcData<{ headBranch: string }>(res)).headBranch).toBe("feat-local");
    expect(existsSync(join(featureDir, "hello.txt"))).toBe(true);

    // A new worktree cannot go there.
    const refused = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: "multi", branch: "new-local", hostId: HUB_HOST },
      TOKEN,
    );
    expect(refused.status).toBe(412);
    expect(JSON.stringify(await refused.json())).toContain("multi is only available on");
  });
});
