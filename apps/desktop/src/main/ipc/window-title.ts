/**
 * `get_app_title` — returns the dynamic window title.
 *
 * Mirrors `apps/dashboard/src-tauri/src/commands/window.rs::get_app_title`:
 * `Band - <branch>` when the working tree has a current branch, else `Band`.
 */

import { getCurrentBranch } from "../services/git.js";

export function getAppTitle(): string {
  const branch = getCurrentBranch();
  return branch ? `Band - ${branch}` : "Band";
}
