import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load .band/config.json, trying the worktree path first, then falling back
 * to the project's main repo path.  This handles the common case where the
 * config file lives on the main branch but is .gitignored, so new worktrees
 * don't contain it.
 */
export function loadProjectConfig(
  worktreePath: string,
  projectPath: string,
): Record<string, unknown> | null {
  for (const base of [worktreePath, projectPath]) {
    const configPath = join(base, ".band", "config.json");
    if (existsSync(configPath)) {
      try {
        return JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        // Malformed JSON – skip and try next location
      }
    }
  }
  return null;
}
