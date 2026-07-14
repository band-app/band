// Black-box integration test for `workspace.getCommitGraph` — the tRPC
// query that backs the Graph panel/tab. It parses `git log --all` from
// the workspace's worktree into a flat commit list the client lays the
// branch tree out from.
//
// Boots the real production server (`dist/start-server.mjs`) against a
// tmp `$HOME` and drives it over real HTTP. The workspace is backed by a
// real on-disk git repo with a couple of commits and a side branch so
// `--all` has more than a single linear history to return. No mocks.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";

const DEFAULT_TOKEN = "workspace-commit-graph-token";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

function seedGitIdentity(tmpHome: string): void {
  writeFileSync(
    join(tmpHome, ".gitconfig"),
    [
      "[user]",
      "  name = Test",
      "  email = test@test.com",
      "[init]",
      "  defaultBranch = main",
      "",
    ].join("\n"),
    "utf-8",
  );
}

/**
 * Build a real repo with three commits across two branches:
 *
 *   main:    initial ─ second
 *   feature:         └─ feature-work
 *
 * `HEAD` ends on `main` (at `second`). Returns the repo path and the SHAs
 * so the assertions can pin the exact parent linkage the client relies on.
 */
function seedRepo(parent: string): {
  path: string;
  initialSha: string;
  secondSha: string;
  featureSha: string;
} {
  const path = join(parent, "alpha");
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);

  writeFileSync(join(path, "README.md"), "# alpha\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "initial"]);
  const initialSha = git(path, ["rev-parse", "HEAD"]).trim();

  git(path, ["checkout", "-b", "feature"]);
  writeFileSync(join(path, "feature.md"), "# feature\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "feature-work"]);
  const featureSha = git(path, ["rev-parse", "HEAD"]).trim();

  git(path, ["checkout", "main"]);
  writeFileSync(join(path, "second.md"), "# second\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "second"]);
  const secondSha = git(path, ["rev-parse", "HEAD"]).trim();

  return { path, initialSha, secondSha, featureSha };
}

interface GraphCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  ts: number;
  subject: string;
  refs: string[];
}

describe("tRPC — workspace.getCommitGraph", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repo: ReturnType<typeof seedRepo>;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-workspace-commit-graph-");
    seedGitIdentity(tmpHome);
    repo = seedRepo(tmpHome);

    seedState(tmpHome, {
      projects: [
        {
          name: "alpha",
          path: repo.path,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo.path }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 401 without a token", async () => {
    const res = await fetch(
      `${server.url}/trpc/workspace.getCommitGraph?input=${encodeURIComponent(
        JSON.stringify({ workspaceId: "alpha-main" }),
      )}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 500 for an unknown workspaceId", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitGraph",
      { workspaceId: "nope-main" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(500);
  });

  it("returns every branch's commits with parent linkage, author, and HEAD", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitGraph",
      { workspaceId: "alpha-main" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);

    const data = await trpcData<{ commits: GraphCommit[]; head: string | null }>(res);

    // HEAD is main's tip (`second`).
    expect(data.head).toBe(repo.secondSha);

    // `--all` surfaces every branch — all three commits are present.
    const bySha = new Map(data.commits.map((c) => [c.sha, c]));
    expect(bySha.size).toBe(3);

    const initial = bySha.get(repo.initialSha);
    const second = bySha.get(repo.secondSha);
    const feature = bySha.get(repo.featureSha);
    expect(initial).toBeDefined();
    expect(second).toBeDefined();
    expect(feature).toBeDefined();

    // Parent linkage — the client draws lanes from this.
    expect(initial?.parents).toEqual([]);
    expect(second?.parents).toEqual([repo.initialSha]);
    expect(feature?.parents).toEqual([repo.initialSha]);

    // Seeded author identity round-trips verbatim.
    expect(second?.author).toBe("Test");
    expect(second?.email).toBe("test@test.com");
    expect(typeof second?.ts).toBe("number");

    // Subjects are parsed intact.
    expect(initial?.subject).toBe("initial");
    expect(second?.subject).toBe("second");
    expect(feature?.subject).toBe("feature-work");

    // Ref decorations: main's tip carries the `main` branch ref, the
    // feature commit carries `feature`.
    expect(second?.refs.some((r) => r.includes("main"))).toBe(true);
    expect(feature?.refs.some((r) => r.includes("feature"))).toBe(true);
  });

  it("honours the limit input", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitGraph",
      { workspaceId: "alpha-main", limit: 1 },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ commits: GraphCommit[]; head: string | null }>(res);
    expect(data.commits).toHaveLength(1);
  });
});
