import { join } from "node:path";
import type { Host } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { z } from "zod";

const log = createLogger("project-config");

/**
 * Load .band/config.json, trying the worktree path first, then falling back
 * to the project's main repo path.  This handles the common case where the
 * config file lives on the main branch but is .gitignored, so new worktrees
 * don't contain it.
 */
export async function loadProjectConfig(
  host: Host,
  worktreePath: string,
  projectPath: string,
): Promise<Record<string, unknown> | null> {
  for (const base of [worktreePath, projectPath]) {
    const text = await readConfig(host, join(base, ".band", "config.json"));
    if (text === null) continue;
    try {
      return JSON.parse(text);
    } catch {
      // Malformed JSON – skip and try next location
    }
  }
  return null;
}

/** The file's text, or `null` when it does not exist (or cannot be read). */
async function readConfig(host: Host, configPath: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await host.fs.readFile(configPath));
  } catch {
    return null;
  }
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
export async function getCopyFiles(host: Host, projectPath: string): Promise<string[] | null> {
  const configPath = join(projectPath, ".band", "config.json");
  const text = await readConfig(host, configPath);
  if (text === null) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
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
    log.warn({ err: parsed.error, configPath }, "invalid workspace.copyFiles config — ignoring");
    return null;
  }

  return parsed.data ?? null;
}
