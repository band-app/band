/**
 * Shared git helpers for e2e tests that need a real on-disk repository
 * as a fixture. Extracted from `find-in-markdown-preview.spec.ts`,
 * which had carried its own inline copy of the identity env + the
 * `git()` shell-out wrapper. `diff-horizontal-scroll.spec.ts` and
 * `diff-mount-once.spec.ts` use this helper from the start so the
 * pattern doesn't keep duplicating itself across the test suite.
 */

import { execFileSync } from "node:child_process";

/** Git environment with deterministic author/committer identity so
 *  commits hashes are reproducible across runs (and CI doesn't need
 *  `user.name` / `user.email` set globally). */
export const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

/** Run a git command in the given working directory, throwing on
 *  failure. Thin wrapper around `execFileSync` that pins the env so
 *  every test's git output is reproducible. */
export function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv });
}
