// Integration test for which host lists a repo's default-branch worktree, and for the flag on
// worktrees whose host is no longer allowed. A real hub (production bundle, temp BAND_HOME) with a
// repo that has a checkout on the hub and on two worker hosts. The workers are rows in the hosts
// table only: listing never needs them online, and a worktree on the hub's own machine proves a
// flagged worktree still opens.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const TOKEN = "repo-primary-host-secret";

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
          { branch: "main", path: "/srv/alpha/multi", hostId: "h-a" },
          { branch: "main", path: "/srv/bravo/multi", hostId: "h-b" },
          { branch: "feat-b", path: "/srv/bravo/wt/feat-b", hostId: "h-b" },
        ],
      },
    ],
  });
  server = await startServer({ tmpHome: home });
}, 60_000);

afterAll(async () => {
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("the primary host lists the default branch (S4)", () => {
  it("lists one default-branch worktree: the hub's own, before a primary is chosen", async () => {
    expect(await listedIds()).toEqual(["multi-feat-b@h-b", "multi-feat-local", "multi-main"]);
    expect((await multi()).primaryHostId).toBe("local");
  });

  it("switches the listed default branch when the primary changes, and moves nothing", async () => {
    await m("repos.update", { name: "multi", primaryHostId: "h-b" });
    expect(await listedIds()).toEqual(["multi-feat-b@h-b", "multi-feat-local", "multi-main@h-b"]);
    expect((await multi()).primaryHostId).toBe("h-b");

    await m("repos.update", { name: "multi", primaryHostId: "h-a" });
    expect(await listedIds()).toEqual(["multi-feat-b@h-b", "multi-feat-local", "multi-main@h-a"]);

    // Nothing moved on disk: the hub's checkout and its worktree are where they were.
    expect(existsSync(join(repoDir, "hello.txt"))).toBe(true);
    expect(existsSync(featureDir)).toBe(true);
  });

  it("lets the hub pick again when the primary is cleared", async () => {
    await m("repos.update", { name: "multi", primaryHostId: null });
    expect((await multi()).primaryHostId).toBe("local");
    expect(await listedIds()).toContain("multi-main");
  });
});

describe("a worktree whose host is no longer allowed (S5)", () => {
  it("is flagged, still resolves, and keeps its files", async () => {
    await m("repos.update", { name: "multi", allowedHostIds: ["h-a", "h-b"] });
    const repo = await multi();
    expect(repo.allowedHostIds).toEqual(["h-a", "h-b"]);

    const flagged = repo.worktrees.filter((w) => w.hostNotAllowed).map((w) => w.worktreeId);
    expect(flagged).toEqual(["multi-feat-local"]);
    // The primary moved off the hub, which the repo may no longer use.
    expect(repo.primaryHostId).toBe("h-a");
    expect(repo.worktrees.find((w) => w.worktreeId === "multi-feat-b@h-b")?.hostNotAllowed).toBe(
      undefined,
    );

    // The flagged worktree still opens: git answers on it, and its folder is untouched.
    const res = await trpcQuery(
      server.url,
      "worktree.getChanges",
      { worktreeId: "multi-feat-local" },
      TOKEN,
    );
    expect(res.status).toBe(200);
    expect((await trpcData<{ headBranch: string }>(res)).headBranch).toBe("feat-local");
    expect(existsSync(join(featureDir, "hello.txt"))).toBe(true);

    // A new worktree cannot go there.
    const refused = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: "multi", branch: "new-local", hostId: "local" },
      TOKEN,
    );
    expect(refused.status).toBe(412);
    expect(JSON.stringify(await refused.json())).toContain("multi is only available on");
  });
});
