import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBatchedCIStatuses } from "../src/server/services/branch-status-poller.ts";

// Exercises the CI-poll failure throttle in `getBatchedCIStatuses` through
// its real public surface — no mocks, no test hooks. We build a real git
// repo whose `origin` resolves a host (so the batching loop actually runs),
// then point the workspace's worktree path at a *non-existent* directory.
// The real `gh` subprocess then fails offline and deterministically with
// `spawn gh ENOENT`, which is exactly the persistent-failure shape the
// throttle exists to de-noise (a long-running server was writing thousands
// of identical `CI poll: GraphQL query failed ...` lines/hour).
//
// This drives the exported batching function directly rather than booting
// the full server: a hermetic `gh` *success* would need network + auth, and
// the throttle is an internal, non-user-observable behaviour. That carve-out
// is recorded in CLAUDE.md → "## Testing Strategy → ### Exceptions"; the same
// direct-function style is used by `git.test.ts`. Recovery is covered through
// the real reset paths the poller actually hits: per-host success (not
// reproducible offline) and the post-loop prune when a host drops out of the
// polled set — the latter is exercised below.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

const CI_POLL_PREFIX = "CI poll: GraphQL query failed for host";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {}
  }
  cleanups.length = 0;
  vi.restoreAllMocks();
});

/**
 * Build a `WorkspaceInfo` whose CI query is guaranteed to fail offline.
 * `projectPath` is a real git repo with an `origin` remote (so
 * `getRepoInfo` resolves `remoteUrl`'s host); `worktreePath` is a path that
 * does not exist, so spawning `gh` in it fails with `spawn gh ENOENT`.
 *
 * Each test uses a unique host so the module-level throttle map (which
 * persists across tests) can't leak between them — the poller's own
 * post-loop prune drops any host not in the current tick's set.
 */
function makeFailingWorkspace(remoteUrl: string, id: string) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-ci-throttle-")));
  const repoPath = join(tmp, "repo");
  mkdirSync(repoPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, env: gitEnv });
  execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: repoPath, env: gitEnv });
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  return {
    workspaceId: id,
    project: id,
    branch: "feature",
    defaultBranch: "main",
    worktreePath: join(tmp, "does-not-exist"),
    projectPath: repoPath,
    hasOrigin: true,
  };
}

/** The `console.error` calls that came from the CI-poll failure path. */
function ciPollCalls(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.filter(
    (call) => typeof call[0] === "string" && (call[0] as string).startsWith(CI_POLL_PREFIX),
  );
}

describe("getBatchedCIStatuses CI-poll failure throttle", () => {
  it("logs a persistent identical failure once, not once per tick", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ws = makeFailingWorkspace("git@once.example:fake/repo.git", "once");

    // Three consecutive ticks, all failing with the same error.
    await getBatchedCIStatuses([ws]);
    await getBatchedCIStatuses([ws]);
    const last = await getBatchedCIStatuses([ws]);

    // Positive anchor: the query really failed (status falls back to "none").
    expect(last.get("once")).toEqual({ state: "none" });

    // The failure is logged exactly once despite three ticks.
    const calls = ciPollCalls(errorSpy);
    expect(calls).toHaveLength(1);
    // Message wording/prefix preserved so log greppers keep matching.
    expect(calls[0][0]).toBe(`${CI_POLL_PREFIX} (1 workspaces):`);
    expect(calls[0][1]).toContain("ENOENT");
  });

  it("re-arms logging after a failing host drops out of the polled set", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Host A has one workspace, host B two, so their log lines are
    // distinguishable by the `(N workspaces)` count in the prefix.
    const a = makeFailingWorkspace("git@host-a.example:fake/repo.git", "a1");
    const b1 = makeFailingWorkspace("git@host-b.example:fake/repo.git", "b1");
    const b2 = makeFailingWorkspace("git@host-b.example:fake/other.git", "b2");
    const countFor = (n: number) =>
      ciPollCalls(errorSpy).filter((c) => c[0] === `${CI_POLL_PREFIX} (${n} workspaces):`).length;

    await getBatchedCIStatuses([a]);
    expect(countFor(1)).toBe(1); // host A's first failure logs

    await getBatchedCIStatuses([a]);
    expect(countFor(1)).toBe(1); // identical failure suppressed

    // Host A drops out of the polled set; host B is polled instead. The
    // poller's post-loop prune clears A's throttle state — the real path
    // hit when a project/host disappears between ticks.
    await getBatchedCIStatuses([b1, b2]);
    expect(countFor(2)).toBe(1); // host B logs once

    // Host A returns and still fails → re-armed, so it logs again.
    await getBatchedCIStatuses([a]);
    expect(countFor(1)).toBe(2);
  });

  it("throttles each host independently", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const github = makeFailingWorkspace("git@indep-a.example:fake/repo.git", "ia");
    const enterprise = makeFailingWorkspace("git@indep-b.example:fake/repo.git", "ib");

    // First tick with both hosts failing → one log per host.
    await getBatchedCIStatuses([github, enterprise]);
    expect(ciPollCalls(errorSpy)).toHaveLength(2);

    // Second tick, same failures on both hosts → both suppressed.
    await getBatchedCIStatuses([github, enterprise]);
    expect(ciPollCalls(errorSpy)).toHaveLength(2);
  });
});
