import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createLogger } from "@band-app/logger";
import { gitCmd } from "../git/git-client";
import { getCopyFiles } from "./project-config";

const log = createLogger("workspace-files");

/**
 * Copy untracked files from the project's main checkout into a freshly
 * created worktree. Driven by two declarative sources at the project root:
 *
 *   1. `.band/config.json::workspace.copyFiles` — explicit list of paths
 *      (literals or glob patterns) relative to the project root.
 *   2. `.worktreeinclude` — gitignore-syntax patterns at the project root.
 *      Only entries that match a pattern AND are ignored by the project's
 *      `.gitignore` are copied (Claude Code parity); tracked files are
 *      never duplicated.
 *
 * When both sources exist, their resolved file sets are UNIONed and
 * de-duped by absolute source path. Missing source files are skipped with a
 * single per-file warning rather than aborting the workspace creation —
 * stale entries in the config are a routine occurrence (a contributor
 * deleted a file, a teammate hasn't added theirs yet) and aborting the
 * workspace boot would punish the user for a non-fatal config drift.
 *
 * Copies are regular file copies (not symlinks) so subsequent edits inside
 * the worktree don't bleed back to the main checkout. Relative directory
 * structure is preserved — `config/local.json` lands at
 * `<worktree>/config/local.json`.
 *
 * Returns the list of relative paths actually copied. Used by the create
 * path's logger and by the integration tests to assert the union /
 * de-duplication shape.
 *
 * Synchronous on purpose: the create path is already synchronous through
 * `execFileSync` for `git worktree add`, the copy fan-out runs once per
 * workspace creation, and the file counts here are in the tens at most —
 * the cost is dominated by the git worktree command, not by these copies.
 */
export function copyWorkspaceFiles(projectPath: string, worktreePath: string): string[] {
  // Resolve both Option A (config.json::workspace.copyFiles) and Option B
  // (.worktreeinclude) into lists of absolute source paths inside the
  // project root. De-dup by absolute path so a file declared in both
  // sources is only copied once. Source-tagging is preserved for the
  // debug log line per the spec ("Log the source of each copied file at
  // debug level").
  const byAbs = new Map<string, "config.json" | ".worktreeinclude">();
  const missingFromConfig: string[] = [];

  const fromConfig = resolveFromConfig(projectPath, missingFromConfig);
  for (const abs of fromConfig) {
    if (!byAbs.has(abs)) byAbs.set(abs, "config.json");
  }

  const fromInclude = resolveFromWorktreeInclude(projectPath);
  for (const abs of fromInclude) {
    if (!byAbs.has(abs)) byAbs.set(abs, ".worktreeinclude");
  }

  // Emit a single warning per missing Option-A source file — globs that
  // resolve to nothing also funnel through `missingFromConfig` so a
  // user-visible warning is emitted whether the pattern is a literal or
  // a no-match glob.
  for (const missing of missingFromConfig) {
    log.warn(
      { source: ".band/config.json::workspace.copyFiles", entry: missing },
      "workspace.copyFiles entry not found in project — skipping",
    );
  }

  // Resolve the project root once to compare against `realpathSync`
  // results below. `realpathSync` returns canonical paths with
  // OS-resolved symlinks, so the comparison root must be canonical too
  // — otherwise a project at `/var/folders/...` (macOS) wouldn't match
  // a realpath under `/private/var/folders/...`.
  const copied: string[] = [];
  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = realpathSync(projectPath);
  } catch (err) {
    // If the project root itself can't be canonicalised, every
    // per-file `realpathSync` comparison below would mismatch and
    // silently refuse all copies. Bail loudly instead so the skipped
    // copy is visible rather than masquerading as "nothing to copy".
    log.warn({ err, projectPath }, "failed to resolve project root — skipping workspace file copy");
    return copied;
  }
  for (const [absSource, source] of byAbs) {
    const rel = relative(projectPath, absSource);
    const dest = join(worktreePath, rel);

    // Defense in depth: skip anything that escapes the worktree root
    // (e.g. a config entry of `../../etc/passwd`). The resolved-relative
    // path check catches both literal `..` segments and absolute path
    // entries normalised by `relative()`.
    if (rel.startsWith("..") || isAbsolute(rel)) {
      log.warn(
        { source, entry: absSource },
        "refusing to copy file outside project root — skipping",
      );
      continue;
    }

    try {
      // Symlink-escape guard: `copyFileSync` follows symlinks when
      // reading the source, so a symlink inside the project root
      // pointing OUTSIDE (`<root>/.env -> /etc/passwd`) would pass the
      // relative-path check above (the symlink *path* is inside the
      // root) but `copyFileSync` would copy the target's bytes into the
      // worktree. Resolving via `realpathSync` and comparing to the
      // canonical project root closes that vector. Equal paths
      // (canonicalProjectRoot === canonicalSource — i.e. the entry
      // itself IS the project root, e.g. a degenerate `.` glob match)
      // and proper descendants both pass. `realpathSync` also throws
      // `ENOENT` if the source disappeared between resolution and copy
      // (a Option-B git pass racing a delete, a vanished Option-A
      // literal) — handled as "source file disappeared" in the catch.
      const canonicalSource = realpathSync(absSource);
      const insideRoot =
        canonicalSource === canonicalProjectRoot ||
        canonicalSource.startsWith(canonicalProjectRoot + sep);
      if (!insideRoot) {
        log.warn(
          { source, entry: rel, target: canonicalSource },
          "refusing to copy symlink that points outside project root — skipping",
        );
        continue;
      }

      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(absSource, dest);
      log.debug({ source, file: rel }, "copied workspace file");
      copied.push(rel);
    } catch (err) {
      // A copy failure (permission, EISDIR, etc.) is non-fatal for the
      // same reason missing files are: the user clicked "New workspace"
      // and the workspace is otherwise functional. A source that
      // vanished between resolution and copy surfaces here too, as an
      // `ENOENT` from `realpathSync`/`copyFileSync` — give it the
      // clearer "disappeared" message and treat the rest as copy
      // failures.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        log.warn({ source, entry: rel }, "source file disappeared — skipping");
      } else {
        log.warn({ err, source, entry: rel }, "failed to copy workspace file");
      }
    }
  }

  return copied;
}

/**
 * Resolve OPTION A — `.band/config.json::workspace.copyFiles` — into absolute
 * source paths inside `projectPath`. Entries containing glob meta-characters
 * are expanded against the project root; literal entries are checked for
 * existence directly. Misses (literal that doesn't exist, glob that yields
 * no matches) are pushed onto `missing` so the caller can emit a warning per
 * entry.
 */
function resolveFromConfig(projectPath: string, missing: string[]): string[] {
  const entries = getCopyFiles(projectPath);
  if (!entries || entries.length === 0) return [];

  const out: string[] = [];
  for (const entry of entries) {
    // Reject absolute paths and traversals up front — they would escape
    // the project root and the relative-path computation downstream
    // can't produce a sensible destination for them.
    if (isAbsolute(entry) || entry.startsWith("..")) {
      // Already warned with the accurate "must be project-relative"
      // message here — do NOT funnel through `missing[]`, or the
      // caller's loop emits a second, misleading "not found in project"
      // warning for the same entry.
      log.warn({ entry }, "workspace.copyFiles entry must be a project-relative path — skipping");
      continue;
    }

    if (hasGlobMeta(entry)) {
      // `globSync` honours its `cwd` for resolution and returns paths
      // relative to it. Convert to absolute for the de-dup key. Set
      // `withFileTypes: false` (the default) so we get string paths.
      const matches = globSync(entry, { cwd: projectPath });
      if (matches.length === 0) {
        missing.push(entry);
        continue;
      }
      for (const m of matches) {
        const abs = resolve(projectPath, m);
        // Skip directories — copyFiles is a *files* declaration; recursing
        // into directories isn't part of the v1 contract. A user who
        // wants every file under `config/` should write `config/*` or
        // `config/**`.
        try {
          if (statSync(abs).isFile()) {
            out.push(abs);
          }
        } catch {
          // stat failure (broken symlink, permission) — treat as miss.
        }
      }
    } else {
      const abs = resolve(projectPath, entry);
      // A single `statSync` with try/catch covers both existence and
      // file-type: `ENOENT` (missing literal) lands in the catch as a
      // miss; a directory or non-regular entry stats fine but fails
      // `isFile()` and is ignored silently (the spec only covers files).
      try {
        if (statSync(abs).isFile()) {
          out.push(abs);
        }
      } catch {
        missing.push(entry);
      }
    }
  }
  return out;
}

/**
 * Resolve OPTION B — `.worktreeinclude` — into absolute source paths inside
 * `projectPath`. The matching is delegated to `git ls-files` so the
 * gitignore-syntax semantics of `.worktreeinclude` exactly match git's own
 * (anchored leading slash, `**` segments, character classes, the full
 * pattern grammar — none of which a custom matcher could keep in sync with
 * upstream git).
 *
 * Two `git ls-files` calls and an in-memory intersection:
 *
 *   - Y: untracked files matching `.worktreeinclude` patterns
 *     (`--others --ignored -X .worktreeinclude`).
 *   - X: untracked files ignored by the project's standard gitignore
 *     rules (`--others --ignored --exclude-standard`).
 *
 * The intersection is the set we want — files that match the include
 * patterns AND are gitignored AND are not tracked. Combining both flag
 * groups in a single `ls-files` call would UNION the rule sets instead, so
 * the two-call shape is load-bearing.
 *
 * Falls back to an empty list if `git` isn't available or the project isn't
 * a git repo — Option B is a no-op in that case (Option A still works).
 */
function resolveFromWorktreeInclude(projectPath: string): string[] {
  const includePath = join(projectPath, ".worktreeinclude");
  if (!existsSync(includePath)) return [];

  // Read the file just to check it's non-empty after stripping
  // comments/blank lines — git tolerates an empty patterns file but the
  // semantics are the same as "no Option B."
  const includeContent = readFileSync(includePath, "utf-8");
  const hasPatterns = includeContent.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
  if (!hasPatterns) return [];

  const { command, env } = gitCmd();
  const opts = { cwd: projectPath, env, encoding: "utf-8" as const };

  let matchingWorktreeInclude: string[];
  let gitignoredStandard: string[];
  try {
    matchingWorktreeInclude = execFileSync(
      command,
      ["ls-files", "--others", "--ignored", `-X`, includePath],
      opts,
    )
      .split("\n")
      .filter(Boolean);
    gitignoredStandard = execFileSync(
      command,
      ["ls-files", "--others", "--ignored", "--exclude-standard"],
      opts,
    )
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    // Not a git repo, git missing, etc. Don't fail the workspace boot —
    // Option B simply contributes nothing.
    log.warn({ err, projectPath }, ".worktreeinclude present but git ls-files failed");
    return [];
  }

  const standardSet = new Set(gitignoredStandard);
  const out: string[] = [];
  for (const rel of matchingWorktreeInclude) {
    if (!standardSet.has(rel)) continue;
    out.push(resolve(projectPath, rel));
  }
  return out;
}

/**
 * Conservative glob-meta detector: returns `true` for patterns that should
 * go through `globSync`, `false` for literal paths. Mirrors the characters
 * `node:fs::glob` treats as special (`*`, `?`, `[`, `{`, ... — we check the
 * subset that's relevant to the gitignore-style patterns users actually
 * write).
 */
function hasGlobMeta(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}
