/**
 * Shared git helpers for e2e tests that need a real on-disk repository
 * as a fixture. The existing `find-in-markdown-preview.spec.ts`,
 * `diff-horizontal-scroll.spec.ts`, and `diff-mount-once.spec.ts` all
 * built their own copy of these — centralised here so future tests
 * don't keep duplicating the same git-identity env block.
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
