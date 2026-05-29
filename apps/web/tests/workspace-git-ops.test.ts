// Black-box integration tests for the workspace router's git-side
// procedures that were lifted out of the legacy inline handler into
// `WorkspaceService` in issue #535: `workspace.gitPull`, `gitPush`,
// `gitCommit`, `switchAgent`, plus the no-agent pre-flight branch of
// `generateCommitMessage`.
//
// These tests boot the real production server (`dist/start-server.mjs`)
// against a tmp `$HOME` and drive it via real HTTP. Each describe block
// seeds its own bare "origin" repo and a working repo cloned from it,
// so push/pull have real refs to operate on. No mocks. `generate-
// CommitMessage`'s full agent-driven path needs a real coding-agent
// binary and is exempt from CI (same carve-out CLAUDE.md grants the
// codex-adapter unit tests); we cover only the synchronous pre-flight
// branch that throws before any agent is spawned.

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
  trpcMutate,
} from "./helpers/server";

const DEFAULT_TOKEN = "workspace-git-ops-token";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
  } catch (err) {
    // Re-raise with stderr + status + signal so the test failure carries
    // the real reason git refused, not just "Command failed: git …".
    const e = err as {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      status?: number | null;
      signal?: string | null;
      message: string;
    };
    const stderr = e.stderr ? String(e.stderr).trim() : "(no stderr)";
    const stdout = e.stdout ? String(e.stdout).trim() : "(no stdout)";
    throw new Error(
      `git ${args.join(" ")} (cwd=${cwd}) failed status=${e.status} signal=${e.signal}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
}

/**
 * Create a bare repo at `<parent>/<name>.git` that acts as the origin
 * the working clone(s) push to and pull from. Returns the bare repo's
 * filesystem path so the caller can use it as `git clone` source.
 */
function createBareOrigin(parent: string, name: string): string {
  const path = join(parent, `${name}.git`);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "--bare", "-b", "main"]);
  return path;
}

/**
 * Seed a `.gitconfig` inside the test's tmp `$HOME` so the *server*
 * subprocess (which inherits `HOME=tmpHome`, not the test process's
 * env) has a `user.name` / `user.email` to commit with. Without this,
 * `git commit` inside the server's gitCommit handler fails on hosts
 * (CI runners) that don't carry an identity in /etc/gitconfig.
 */
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
 * Clone `originPath` into `<parent>/<name>`. If the origin has no
 * commits yet, seeds an initial commit on `main` and pushes it back so
 * subsequent clones land on a non-empty repo. Returns the working
 * repo's path.
 */
function createWorkingClone(parent: string, name: string, originPath: string): string {
  const path = join(parent, name);
  git(parent, ["clone", originPath, name]);

  // Distinguish empty-origin from already-seeded-origin: `git rev-parse
  // HEAD` exits non-zero when the clone has no commits.
  let alreadySeeded = false;
  try {
    git(path, ["rev-parse", "HEAD"]);
    alreadySeeded = true;
  } catch {
    alreadySeeded = false;
  }

  if (!alreadySeeded) {
    writeFileSync(join(path, "README.md"), "# Working repo\n");
    git(path, ["add", "."]);
    git(path, ["commit", "-m", "initial"]);
    git(path, ["push", "-u", "origin", "main"]);
  } else {
    // Make sure the cloned working dir knows main's upstream so the
    // subsequent `git push` in tests doesn't trip the "no upstream"
    // branch — `git clone` already sets it up, but the assertion is
    // safer than the assumption.
    git(path, ["branch", "--set-upstream-to=origin/main", "main"]);
  }
  return path;
}

// ---------------------------------------------------------------------------
// workspace.gitPull
// ---------------------------------------------------------------------------

describe("tRPC — workspace.gitPull", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let originPath: string;
  let workingPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-workspace-git-pull-");
    originPath = createBareOrigin(tmpHome, "origin");
    workingPath = createWorkingClone(tmpHome, "alpha", originPath);

    // Add a second, separate clone, push a new commit from it back to
    // origin, then nuke it. The working clone is now behind by one
    // commit so `gitPull` has something to fast-forward.
    const seederPath = createWorkingClone(tmpHome, "seeder", originPath);
    writeFileSync(join(seederPath, "from-seeder.md"), "# from seeder\n");
    git(seederPath, ["add", "."]);
    git(seederPath, ["commit", "-m", "added from seeder"]);
    git(seederPath, ["push", "origin", "main"]);
    rmSync(seederPath, { recursive: true, force: true });

    seedState(tmpHome, {
      projects: [
        {
          name: "alpha",
          path: workingPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: workingPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    seedGitIdentity(tmpHome);
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns ok and fast-forwards the workspace's worktree", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.gitPull",
      { workspaceId: "alpha-main" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data).toEqual({ ok: true });

    // Observable side effect: the seeded file should now exist in the
    // working clone — that's the file the seeder clone pushed to origin
    // before `gitPull` ran here.
    expect(
      execFileSync("git", ["log", "--oneline", "-1", "main"], {
        cwd: workingPath,
        encoding: "utf-8",
      }),
    ).toMatch(/added from seeder/);
  });

  it("returns 500 for an unknown workspaceId", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.gitPull",
      { workspaceId: "nope-main" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(500);
  });

  it("returns 401 without a token", async () => {
    const res = await fetch(`${server.url}/trpc/workspace.gitPull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "alpha-main" }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// workspace.gitPush
// ---------------------------------------------------------------------------

describe("tRPC — workspace.gitPush", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let originPath: string;
  let workingPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-workspace-git-push-");
    originPath = createBareOrigin(tmpHome, "origin");
    workingPath = createWorkingClone(tmpHome, "alpha", originPath);

    // Pre-create one local commit ahead of origin so gitPush has
    // something to upload. Real working repos will be ahead any time
    // the user just committed.
    writeFileSync(join(workingPath, "local.md"), "# Local commit\n");
    git(workingPath, ["add", "."]);
    git(workingPath, ["commit", "-m", "local change"]);

    seedState(tmpHome, {
      projects: [
        {
          name: "alpha",
          path: workingPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: workingPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    seedGitIdentity(tmpHome);
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns ok and the new commit lands on origin", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.gitPush",
      { workspaceId: "alpha-main" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data).toEqual({ ok: true });

    // Observable side effect: the bare origin's `main` ref now points
    // at the same SHA the working repo's HEAD does.
    const workingHead = execFileSync("git", ["rev-parse", "main"], {
      cwd: workingPath,
      encoding: "utf-8",
    }).trim();
    const originHead = execFileSync("git", ["rev-parse", "main"], {
      cwd: originPath,
      encoding: "utf-8",
    }).trim();
    expect(originHead).toBe(workingHead);
  });

  it("returns 500 for an unknown workspaceId", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.gitPush",
      { workspaceId: "nope-main" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// workspace.gitCommit
// ---------------------------------------------------------------------------

describe("tRPC — workspace.gitCommit", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let workingPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-workspace-git-commit-");
    const originPath = createBareOrigin(tmpHome, "origin");
    workingPath = createWorkingClone(tmpHome, "alpha", originPath);

    // Drop an unstaged change so gitCommit has something to stage.
    writeFileSync(join(workingPath, "new.md"), "# New change\n");

    seedState(tmpHome, {
      projects: [
        {
          name: "alpha",
          path: workingPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: workingPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    seedGitIdentity(tmpHome);
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("stages every pending file and creates a commit with the supplied message + body", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.gitCommit",
      {
        workspaceId: "alpha-main",
        message: "Add new.md",
        body: "Tracks the new note file.",
      },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data).toEqual({ ok: true });

    // Observable side effect: `git log -1` reports the subject and body
    // exactly as supplied. The trailing %n+blank-line check ensures the
    // service passed two `-m` flags instead of joining them into one.
    const log = execFileSync("git", ["log", "-1", "--format=%s%n%n%b"], {
      cwd: workingPath,
      encoding: "utf-8",
    }).trim();
    expect(log).toBe("Add new.md\n\nTracks the new note file.");

    // No pending changes left after the commit landed.
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: workingPath,
      encoding: "utf-8",
    });
    expect(status).toBe("");
  });

  it("rejects an empty commit message", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.gitCommit",
      { workspaceId: "alpha-main", message: "" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 for an unknown workspaceId", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.gitCommit",
      { workspaceId: "nope-main", message: "noop" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// workspace.switchAgent — wire-contract + state side-effect coverage
// ---------------------------------------------------------------------------

describe("tRPC — workspace.switchAgent", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let workingPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-workspace-switch-agent-");
    const originPath = createBareOrigin(tmpHome, "origin");
    workingPath = createWorkingClone(tmpHome, "alpha", originPath);

    seedState(tmpHome, {
      projects: [
        {
          name: "alpha",
          path: workingPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: workingPath }],
        },
      ],
    });

    // Seed both agent definitions so the switch has a non-default target
    // to flip to. `command: "/bin/false"` ensures the agent binary never
    // actually launches — `switchAgent` invokes `replaceAgent` which
    // calls into the SDK lazily; the synchronous pool slot update is
    // what we actually want to observe, and the agent process is torn
    // down before it runs by the abort + clear-queued-messages calls.
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      defaultCodingAgent: "claude-code",
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: "/bin/false" },
        { id: "codex", type: "codex", label: "Codex", command: "/bin/false" },
      ],
    });

    seedGitIdentity(tmpHome);
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns NOT_FOUND (404) for an unknown workspaceId", async () => {
    // Pinned wire contract: pre-#535 the router threw
    // TRPCError({ code: "NOT_FOUND" }) for this branch; the refactor
    // restored it via an explicit catch in workspace/router.ts. This
    // assertion regresses if the catch is dropped.
    const res = await trpcMutate(
      server.url,
      "workspace.switchAgent",
      { workspaceId: "nope-main", agentId: "codex" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 without a token", async () => {
    const res = await fetch(`${server.url}/trpc/workspace.switchAgent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "alpha-main", agentId: "codex" }),
    });
    expect(res.status).toBe(401);
  });

  it("happy path: switching the agent updates the chat row and bumps the workspace status", async () => {
    // The router first materialises the default chat via
    // `chatService.getOrCreateDefault`. We let `switchAgent` itself
    // do that — it's the same code path the dashboard hits.
    const res = await trpcMutate(
      server.url,
      "workspace.switchAgent",
      { workspaceId: "alpha-main", agentId: "codex" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data).toEqual({ ok: true });

    // Side effect 1: the chat row's `agent` field now reflects the
    // new agent id. Drive `chats.list` via real HTTP — the same
    // surface the dashboard renders the agent dropdown from.
    const chatsRes = await fetch(
      `${server.url}/trpc/chats.list?input=${encodeURIComponent(
        JSON.stringify({ workspaceId: "alpha-main" }),
      )}`,
      { headers: { Cookie: `band_token=${DEFAULT_TOKEN}` } },
    );
    expect(chatsRes.status).toBe(200);
    const chatsData = await trpcData<{
      chats: Array<{ id: string; agent: string | null }>;
    }>(chatsRes);
    expect(chatsData.chats.length).toBeGreaterThan(0);
    expect(chatsData.chats[0].agent).toBe("codex");

    // Side effect 2: the workspace_statuses row stores the new
    // codingAgentId, visible via the per-workspace `statuses.get`.
    const statusesRes = await fetch(
      `${server.url}/trpc/statuses.get?input=${encodeURIComponent(
        JSON.stringify({ workspaceId: "alpha-main" }),
      )}`,
      { headers: { Cookie: `band_token=${DEFAULT_TOKEN}` } },
    );
    expect(statusesRes.status).toBe(200);
    // `statuses.get` returns the `WorkspaceStatus | null` shape directly,
    // not wrapped under a `.status` field.
    const statusData = await trpcData<{
      workspaceId: string;
      agent?: { codingAgentId?: string };
    } | null>(statusesRes);
    expect(statusData?.agent?.codingAgentId).toBe("codex");
  });
});

// ---------------------------------------------------------------------------
// workspace.generateCommitMessage — pre-flight branch only
// ---------------------------------------------------------------------------
//
// The agent-driven branch needs a real `claude-code` / `codex` binary
// and is exempt from CI per the codex-adapter carve-out in CLAUDE.md.
// We can still cover the synchronous pre-flight branch — when there are
// no pending changes the service throws "No changes to summarise" BEFORE
// any agent is spawned, so a /bin/false binary is fine.

describe("tRPC — workspace.generateCommitMessage", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-workspace-gen-msg-");
    const originPath = createBareOrigin(tmpHome, "origin");
    const workingPath = createWorkingClone(tmpHome, "alpha", originPath);

    seedState(tmpHome, {
      projects: [
        {
          name: "alpha",
          path: workingPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: workingPath }],
        },
      ],
    });

    // Pin a single coding agent with a non-launchable binary. The
    // pre-flight `git status --porcelain` runs first and rejects, so
    // the agent binary is never spawned in the assertion below.
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      defaultCodingAgent: "claude-code",
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: "/bin/false" },
      ],
    });

    seedGitIdentity(tmpHome);
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 500 with 'No changes to summarise' when the worktree is clean", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.generateCommitMessage",
      { workspaceId: "alpha-main" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/No changes to summarise/i);
  });

  it("returns 500 for an unknown workspaceId", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.generateCommitMessage",
      { workspaceId: "nope-main" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(500);
  });
});
