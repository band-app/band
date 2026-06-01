import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import { z } from "zod";

const log = createLogger("project-config");

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

/**
 * Schema for the `workspace.copyFiles` block of `.band/config.json`. Used by
 * `WorkspaceService.create` to seed a fresh worktree with untracked files
 * (`.env`, local credential overrides, IDE settings) that aren't committed to
 * the repo — a fresh worktree starts without them by definition. See issue
 * #284 for the full design.
 *
 * The shape is intentionally narrow (`string[]` only) so a malformed entry
 * fails validation up front instead of being silently dropped during the
 * copy. Globs are accepted in the strings themselves and expanded against
 * the project root by `copyWorkspaceFiles`.
 */
const CopyFilesSchema = z.array(z.string()).optional();

/**
 * Read the `workspace.copyFiles` list from `.band/config.json` at the project
 * root. The config is read directly from `projectPath` rather than going
 * through {@link loadProjectConfig}'s worktree-first fallback: copy
 * resolution is deterministic only when the source is the main checkout (a
 * fresh worktree never has the file yet, and reading it from another
 * worktree would produce a different result depending on which worktree the
 * server happened to look at).
 *
 * Returns `null` when:
 *   - `.band/config.json` is absent at the project root.
 *   - The file fails to parse as JSON.
 *   - The `workspace.copyFiles` block is missing.
 *   - The block is present but fails schema validation (logged at warn).
 *
 * A `null` return is indistinguishable from an empty list at the call site
 * and intentionally so — both mean "no Option-A copies."
 */
export function getCopyFiles(projectPath: string): string[] | null {
  const configPath = join(projectPath, ".band", "config.json");
  if (!existsSync(configPath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    log.warn({ err, configPath }, "failed to parse .band/config.json");
    return null;
  }

  if (!raw || typeof raw !== "object") return null;
  const workspace = (raw as Record<string, unknown>).workspace;
  if (!workspace || typeof workspace !== "object") return null;
  const copyFiles = (workspace as Record<string, unknown>).copyFiles;
  if (copyFiles === undefined) return null;

  const parsed = CopyFilesSchema.safeParse(copyFiles);
  if (!parsed.success) {
    log.warn(
      "Invalid workspace.copyFiles config: %s",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
    return null;
  }

  return parsed.data ?? null;
}
