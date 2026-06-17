// Integration test for workspace file copying (issue #284).
//
// A fresh git worktree starts empty of any untracked files — `.env`, local
// credentials, IDE overrides, anything `.gitignore`d. Workspace creation
// can now declaratively copy a set of those files from the project's main
// checkout into the new worktree, driven by either:
//
//   1. `.band/config.json::workspace.copyFiles` — explicit list, supports
//      globs.
//   2. `.worktreeinclude` — gitignore-syntax patterns; only entries that
//      match AND are gitignored are copied (Claude Code parity, so tracked
//      files are never duplicated).
//
// Both sources can be present at once; the resulting file set is the
// UNION, de-duped by absolute source path.
//
// This file boots the real server (`apps/web/dist/start-server.mjs`)
// against a fresh tmp `$HOME`, drives `workspaces.create` over real tRPC,
// and asserts on the filesystem contents of the resulting worktree.
//
// The seven scenarios spelled out in the acceptance criteria each get
// their own `it()` block so a regression in one isn't masked by a passing
// neighbour:
//
//   - only `.band/config.json`
//   - only `.worktreeinclude`
//   - both present (UNION + de-dup)
//   - missing source files (skipped, not fatal)
//   - glob match
//   - gitignored-but-not-`.worktreeinclude`-matched (skipped)
//   - matched-but-tracked (skipped)
//
// Each scenario uses its own project subdirectory inside the shared tmp
// home so the seven creates don't fight over the same `.band/config.json`
// / `.worktreeinclude` files. The server boots once for the file.
//
// See docs/integration-testing.md and .claude/skills/write-integration-test/SKILL.md
// for the real-server doctrine this file implements (TEST-1...TEST-35 in
// .claude/testing-criteria.md).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";

const DEFAULT_TOKEN = "workspace-copy-files-token";

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

interface ProjectFixture {
  name: string;
  /** Absolute path to the project's main checkout. */
  repoPath: string;
  /** Expected path of the worktree this project's create will produce. */
  worktreePath: string;
}

interface CreateRepoOpts {
  /**
   * Files to write before the initial commit, keyed by relative path. The
   * test uses this to commit `.gitignore` and any tracked files (e.g. the
   * `tracked-but-matched.json` regression for the seventh scenario).
   */
  trackedFiles: Record<string, string>;
  /**
   * Files to write AFTER the initial commit. These end up as untracked
   * files in the working tree — the candidate set for both Option A and
   * Option B copies. Keyed by relative path.
   */
  untrackedFiles: Record<string, string>;
  /**
   * Files to write AFTER the initial commit, OVERWRITING tracked content
   * left on disk. These bytes live only in the main checkout's working
   * tree — `git worktree add` for a new branch checks out the committed
   * version. Used by the "matched-but-tracked" scenario to make the
   * "Option B re-copied a tracked file" failure mode observable: if the
   * implementation incorrectly re-copies, the worktree ends up with the
   * post-commit bytes instead of the committed bytes.
   */
  mutateAfterCommit?: Record<string, string>;
  /**
   * `.band/config.json` payload. Omitted when the test only exercises
   * Option B.
   */
  bandConfig?: object;
  /**
   * `.worktreeinclude` content. Omitted when the test only exercises
   * Option A.
   */
  worktreeInclude?: string;
}

/**
 * Build a project fixture: create a real git repo with the given tracked
 * + untracked files, optionally write `.band/config.json` and
 * `.worktreeinclude`, and seed the state DB so the server knows about it.
 *
 * Each fixture uses its own subdirectory of `tmpHome` so creates from
 * different scenarios don't clobber each other's config / include files.
 */
function buildProject(
  tmpHome: string,
  name: string,
  branch: string,
  opts: CreateRepoOpts,
): ProjectFixture {
  const repoPath = join(tmpHome, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);

  for (const [path, content] of Object.entries(opts.trackedFiles)) {
    const abs = join(repoPath, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);

  for (const [path, content] of Object.entries(opts.untrackedFiles)) {
    const abs = join(repoPath, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  for (const [path, content] of Object.entries(opts.mutateAfterCommit ?? {})) {
    const abs = join(repoPath, path);
    writeFileSync(abs, content);
  }

  if (opts.bandConfig) {
    mkdirSync(join(repoPath, ".band"), { recursive: true });
    writeFileSync(join(repoPath, ".band", "config.json"), JSON.stringify(opts.bandConfig, null, 2));
  }
  if (opts.worktreeInclude !== undefined) {
    writeFileSync(join(repoPath, ".worktreeinclude"), opts.worktreeInclude);
  }

  // Worktree path lands under `<tmpHome>/.band/worktrees/<project>/<branch>`
  // because `seedSettings` below sets `worktreesDir` to that location.
  const worktreePath = join(tmpHome, ".band", "worktrees", name, branch);

  return { name, repoPath, worktreePath };
}

describe("workspaces.create copies workspace files into the new worktree", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const branch = "feat-copy";

  // Seven independent project fixtures — one per acceptance criterion. We
  // build them all up front so `seedState` can register every project in
  // a single transaction before the server boots.
  let pConfigOnly: ProjectFixture;
  let pIncludeOnly: ProjectFixture;
  let pBoth: ProjectFixture;
  let pMissing: ProjectFixture;
  let pGlob: ProjectFixture;
  let pIgnoredButNotIncluded: ProjectFixture;
  let pMatchedButTracked: ProjectFixture;
  let pSymlinkEscape: ProjectFixture;
  let symlinkEscapeTarget: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-copy-files-");

    pConfigOnly = buildProject(tmpHome, "config-only", branch, {
      trackedFiles: { ".gitignore": ".env\n.env.local\nconfig/*.local.json\n" },
      untrackedFiles: {
        ".env": "ENV_FROM_MAIN=1\n",
        ".env.local": "LOCAL_FROM_MAIN=1\n",
        "config/local.json": '{"main":true}\n',
      },
      bandConfig: {
        workspace: {
          copyFiles: [".env", ".env.local", "config/local.json"],
        },
      },
    });

    pIncludeOnly = buildProject(tmpHome, "include-only", branch, {
      trackedFiles: { ".gitignore": ".env*\nconfig/*.local.json\n" },
      untrackedFiles: {
        ".env": "INCLUDE_ENV=1\n",
        ".env.local": "INCLUDE_LOCAL=1\n",
        "config/foo.local.json": '{"foo":true}\n',
      },
      worktreeInclude: ".env*\nconfig/*.local.json\n",
    });

    pBoth = buildProject(tmpHome, "both", branch, {
      trackedFiles: { ".gitignore": ".env\n.env.local\nshared.local\n" },
      untrackedFiles: {
        ".env": "BOTH_ENV=1\n",
        ".env.local": "BOTH_LOCAL=1\n",
        "shared.local": "SHARED=1\n",
      },
      // Both sources reference `.env` and `shared.local` — that overlap is
      // the de-dup case. `.env.local` is only in Option B; `.env` is in
      // both; `shared.local` is in Option A literal + Option B glob.
      bandConfig: {
        workspace: {
          copyFiles: [".env", "shared.local"],
        },
      },
      worktreeInclude: ".env*\n*.local\n",
    });

    pMissing = buildProject(tmpHome, "missing", branch, {
      trackedFiles: { ".gitignore": ".env\nphantom.txt\n" },
      untrackedFiles: { ".env": "PRESENT=1\n" }, // phantom.txt is deliberately absent
      bandConfig: {
        workspace: {
          copyFiles: [".env", "phantom.txt", "config/does-not-exist.json"],
        },
      },
    });

    pGlob = buildProject(tmpHome, "glob", branch, {
      trackedFiles: { ".gitignore": "config/*.local.json\n" },
      untrackedFiles: {
        "config/a.local.json": '{"a":1}\n',
        "config/b.local.json": '{"b":2}\n',
        "config/c.json": '{"tracked-shape":true}\n',
      },
      bandConfig: {
        workspace: {
          copyFiles: ["config/*.local.json"],
        },
      },
    });

    pIgnoredButNotIncluded = buildProject(tmpHome, "ignored-not-included", branch, {
      trackedFiles: { ".gitignore": ".env\nsecret.key\n" },
      untrackedFiles: {
        ".env": "INCLUDED=1\n",
        "secret.key": "DO-NOT-COPY\n", // gitignored but not in .worktreeinclude
      },
      // `.worktreeinclude` only mentions `.env`, so `secret.key` (also
      // gitignored) must NOT be copied — that's the parity rule.
      worktreeInclude: ".env\n",
    });

    pMatchedButTracked = buildProject(tmpHome, "matched-but-tracked", branch, {
      // `config.json` is committed (tracked) AND matches the `*.json`
      // pattern in `.worktreeinclude`. Tracked files must never be
      // duplicated by Option B — git already provides them via the
      // worktree checkout.
      trackedFiles: {
        ".gitignore": ".env\n",
        "config.json": '{"tracked":true}\n',
      },
      untrackedFiles: {
        ".env": "FROM_INCLUDE=1\n",
      },
      // Overwrite the working-tree copy of `config.json` AFTER the commit
      // so the main checkout's on-disk bytes differ from the committed
      // bytes. `git worktree add` checks out the committed bytes into the
      // new worktree — so if the implementation correctly skips the
      // tracked file, the worktree holds `{"tracked":true}`. If it
      // incorrectly re-copies from the main checkout, the worktree gets
      // `{"tracked":true,"WORKING_TREE_DRIFT":true}` and the assertion
      // below fails. This is what makes the test falsifiable.
      mutateAfterCommit: {
        "config.json": '{"tracked":true,"WORKING_TREE_DRIFT":true}\n',
      },
      worktreeInclude: "*.json\n.env\n",
    });

    pSymlinkEscape = buildProject(tmpHome, "symlink-escape", branch, {
      trackedFiles: { ".gitignore": "escape.txt\n" },
      untrackedFiles: {},
      bandConfig: {
        workspace: {
          // The symlink at `<repo>/escape.txt` is created below — it
          // points OUTSIDE the project root. Listing it here exercises
          // the symlink-escape guard.
          copyFiles: ["escape.txt"],
        },
      },
    });
    // Drop the secret outside the project root in a sibling tmpdir so a
    // resolved-real-path check sees a path that does NOT start with the
    // project root prefix. Using `tmpdir()` rather than parent dirs of
    // the home keeps the test robust to whatever directory layout the
    // test runner picks.
    symlinkEscapeTarget = join(tmpdir(), `band-symlink-escape-target-${Date.now()}.txt`);
    writeFileSync(symlinkEscapeTarget, "SECRET-OUTSIDE-PROJECT\n");
    symlinkSync(symlinkEscapeTarget, join(pSymlinkEscape.repoPath, "escape.txt"));

    seedState(tmpHome, {
      projects: [
        {
          name: pConfigOnly.name,
          path: pConfigOnly.repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: pConfigOnly.repoPath }],
        },
        {
          name: pIncludeOnly.name,
          path: pIncludeOnly.repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: pIncludeOnly.repoPath }],
        },
        {
          name: pBoth.name,
          path: pBoth.repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: pBoth.repoPath }],
        },
        {
          name: pMissing.name,
          path: pMissing.repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: pMissing.repoPath }],
        },
        {
          name: pGlob.name,
          path: pGlob.repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: pGlob.repoPath }],
        },
        {
          name: pIgnoredButNotIncluded.name,
          path: pIgnoredButNotIncluded.repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: pIgnoredButNotIncluded.repoPath }],
        },
        {
          name: pMatchedButTracked.name,
          path: pMatchedButTracked.repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: pMatchedButTracked.repoPath }],
        },
        {
          name: pSymlinkEscape.name,
          path: pSymlinkEscape.repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: pSymlinkEscape.repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
    // The symlink-escape target lives outside `tmpHome`, so it has to be
    // cleaned up explicitly — otherwise repeated test runs leak files
    // under the system tmpdir.
    rmSync(symlinkEscapeTarget, { force: true });
  });

  async function create(project: string): Promise<Response> {
    return trpcMutate(server.url, "workspaces.create", { project, branch }, DEFAULT_TOKEN);
  }

  it("copies files declared only in .band/config.json::workspace.copyFiles", async () => {
    const res = await create(pConfigOnly.name);
    expect(res.status).toBe(200);

    // All three declared files should land in the worktree with the same
    // contents as the main checkout. Use `existsSync` AND a content
    // assertion — symlinks would have the same `existsSync` result, so
    // pin the bytes too. Pinning the literal main-checkout content also
    // catches a silent regression where we copied an empty placeholder
    // (e.g. a missed mkdirSync race).
    expect(existsSync(join(pConfigOnly.worktreePath, ".env"))).toBe(true);
    expect(readFileSync(join(pConfigOnly.worktreePath, ".env"), "utf-8")).toBe("ENV_FROM_MAIN=1\n");
    expect(readFileSync(join(pConfigOnly.worktreePath, ".env.local"), "utf-8")).toBe(
      "LOCAL_FROM_MAIN=1\n",
    );
    expect(readFileSync(join(pConfigOnly.worktreePath, "config", "local.json"), "utf-8")).toBe(
      '{"main":true}\n',
    );

    // Regular file copy, not symlink: edits in the worktree must not bleed
    // back to the main checkout. Mutate the worktree copy, then read the
    // main checkout's copy and assert it's untouched.
    writeFileSync(join(pConfigOnly.worktreePath, ".env"), "MUTATED_IN_WORKTREE=1\n");
    expect(readFileSync(join(pConfigOnly.repoPath, ".env"), "utf-8")).toBe("ENV_FROM_MAIN=1\n");
  });

  it("copies files declared only in .worktreeinclude", async () => {
    const res = await create(pIncludeOnly.name);
    expect(res.status).toBe(200);

    expect(readFileSync(join(pIncludeOnly.worktreePath, ".env"), "utf-8")).toBe("INCLUDE_ENV=1\n");
    expect(readFileSync(join(pIncludeOnly.worktreePath, ".env.local"), "utf-8")).toBe(
      "INCLUDE_LOCAL=1\n",
    );
    expect(readFileSync(join(pIncludeOnly.worktreePath, "config", "foo.local.json"), "utf-8")).toBe(
      '{"foo":true}\n',
    );
  });

  it("UNIONs both sources and de-dups by absolute source path", async () => {
    const res = await create(pBoth.name);
    expect(res.status).toBe(200);

    // `.env` is declared by both sources but the file must land exactly
    // once with the right contents — the de-dup case. There's no
    // straightforward "copied twice" assertion at the filesystem layer
    // (a second copy would just overwrite the first), but the contents
    // and presence are what the user observes.
    expect(readFileSync(join(pBoth.worktreePath, ".env"), "utf-8")).toBe("BOTH_ENV=1\n");
    // `.env.local` is only matched by Option B (`.env*` glob, gitignored
    // via `.env.local` in .gitignore).
    expect(readFileSync(join(pBoth.worktreePath, ".env.local"), "utf-8")).toBe("BOTH_LOCAL=1\n");
    // `shared.local` is in Option A literal AND Option B glob (`*.local`,
    // gitignored). Must be present.
    expect(readFileSync(join(pBoth.worktreePath, "shared.local"), "utf-8")).toBe("SHARED=1\n");
  });

  it("skips missing source files with a warning rather than failing the create", async () => {
    const res = await create(pMissing.name);
    // The create call must succeed end-to-end — missing files are
    // non-fatal per the acceptance criteria.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { data: { ok: boolean; path: string } } };
    expect(body.result.data.ok).toBe(true);

    // Present file is still copied; missing files are simply absent.
    expect(readFileSync(join(pMissing.worktreePath, ".env"), "utf-8")).toBe("PRESENT=1\n");
    expect(existsSync(join(pMissing.worktreePath, "phantom.txt"))).toBe(false);
    expect(existsSync(join(pMissing.worktreePath, "config", "does-not-exist.json"))).toBe(false);
  });

  it("expands glob entries in .band/config.json::workspace.copyFiles", async () => {
    const res = await create(pGlob.name);
    expect(res.status).toBe(200);

    // The glob matches both `.local.json` files; the plain `.json` file
    // (not matching the glob) must NOT be copied.
    expect(readFileSync(join(pGlob.worktreePath, "config", "a.local.json"), "utf-8")).toBe(
      '{"a":1}\n',
    );
    expect(readFileSync(join(pGlob.worktreePath, "config", "b.local.json"), "utf-8")).toBe(
      '{"b":2}\n',
    );
    // `config/c.json` is untracked-but-not-matching-the-glob: NOT copied
    // by our path. It is also not present in the main checkout's first
    // commit (it was written post-commit), so the worktree should not
    // contain it.
    expect(existsSync(join(pGlob.worktreePath, "config", "c.json"))).toBe(false);
  });

  it("skips gitignored files that don't match .worktreeinclude (Claude Code parity)", async () => {
    const res = await create(pIgnoredButNotIncluded.name);
    expect(res.status).toBe(200);

    // `.env` is in both .gitignore AND .worktreeinclude — copied.
    expect(readFileSync(join(pIgnoredButNotIncluded.worktreePath, ".env"), "utf-8")).toBe(
      "INCLUDED=1\n",
    );
    // `secret.key` is gitignored but NOT in .worktreeinclude. The
    // intersection rule must keep it out of the new worktree.
    expect(existsSync(join(pIgnoredButNotIncluded.worktreePath, "secret.key"))).toBe(false);
  });

  it("does not duplicate tracked files that happen to match a .worktreeinclude pattern", async () => {
    const res = await create(pMatchedButTracked.name);
    expect(res.status).toBe(200);

    // `.env` is untracked + gitignored + matches `.env`. Copy expected.
    expect(readFileSync(join(pMatchedButTracked.worktreePath, ".env"), "utf-8")).toBe(
      "FROM_INCLUDE=1\n",
    );

    // `config.json` is a tracked file in the main checkout, and its
    // working-tree bytes were deliberately drifted post-commit to
    // `{"tracked":true,"WORKING_TREE_DRIFT":true}` (see the fixture's
    // `mutateAfterCommit`). `git worktree add` only checks out the
    // *committed* bytes — `{"tracked":true}`. So:
    //   - Correct behaviour (Option B skips tracked files) → worktree
    //     holds the committed bytes.
    //   - Buggy behaviour (Option B re-copies tracked files) → worktree
    //     would be overwritten with the drifted bytes and this assertion
    //     would fail.
    // That asymmetry is what makes the assertion falsifiable.
    expect(readFileSync(join(pMatchedButTracked.worktreePath, "config.json"), "utf-8")).toBe(
      '{"tracked":true}\n',
    );
  });

  it("refuses to follow a symlink that points outside the project root", async () => {
    const res = await create(pSymlinkEscape.name);
    // Create still succeeds — the symlink-escape guard is non-fatal,
    // matching the project's "missing source files are skipped, not
    // errors" contract.
    expect(res.status).toBe(200);

    // The symlink target sits OUTSIDE the project root and contains a
    // secret. A regression that follows the symlink would land its
    // bytes inside the new worktree at `escape.txt`. The guard MUST
    // refuse to copy: the worktree must not contain `escape.txt` at
    // all (since the source is a dangling-after-guard symlink, not a
    // real file we'd want to expose).
    expect(existsSync(join(pSymlinkEscape.worktreePath, "escape.txt"))).toBe(false);
  });

  it("rejects workspaces.create without an auth token (401)", async () => {
    // TEST-13 negative auth case — boots the same server but skips the
    // `Cookie: band_token=...` header by bypassing the `trpcMutate`
    // helper. Pins that the file-copy feature can't be reached
    // unauthenticated; a future regression that loosened auth on the
    // workspaces.create handler would surface here, not just in the
    // shared `trpc.test.ts` suite.
    const res = await fetch(`${server.url}/trpc/workspaces.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: pConfigOnly.name, branch: "unauth-attempt" }),
    });
    expect(res.status).toBe(401);
  });
});
