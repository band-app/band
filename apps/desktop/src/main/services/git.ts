/**
 * Get the current git branch (used by `get_app_title`).
 *
 * Direct port of `apps/dashboard/src-tauri/src/git.rs::get_current_branch`.
 * Returns `null` if the working directory is not a git repo.
 */

import { spawnSync } from "node:child_process";

export function getCurrentBranch(cwd: string = process.cwd()): string | null {
  // Mirror Tauri: prepend Homebrew prefixes so git is found even when launched
  // from a sparse-PATH context (Finder).
  const env = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
  };
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return null;
    const branch = (result.stdout ?? "").trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}
