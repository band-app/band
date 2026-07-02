import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";

/**
 * Resolve the user's interactive `$PATH` by spawning a login shell and
 * echoing `$PATH`. Cached for the lifetime of the process — the value
 * doesn't change without a server restart.
 *
 * Lives in the infra tier so other infra adapters (tunnel-client,
 * lsp-manager, terminal-pool) can reach it without crossing back into
 * services. The services-tier `SystemService` re-exports `shellPath` and
 * `whichBinary` from here so router-facing code continues to import them
 * via the service singleton.
 *
 * Extracted from `lib/process-utils.ts` and parked in the infra tier as
 * part of the Phase 7.5 migration (issue #517) so infra-tier callers
 * (tunnel-client, lsp-manager, terminal-pool) can reach it without
 * crossing back up to services.
 */

/**
 * Resolve the default interactive shell for the host, cross-platform.
 *
 * Honours `$SHELL` when set (the user's chosen login shell on macOS/Linux).
 * Otherwise probes a platform-appropriate candidate list and returns the
 * first that exists on disk: macOS ships zsh at `/bin/zsh`, most Linux
 * distros ship bash (`/bin/bash`) with `/bin/sh` as the POSIX floor that is
 * effectively always present. On Windows there is no `$SHELL`, so fall back
 * to `%ComSpec%` (cmd.exe) — a best-effort stub for the Windows follow-up
 * (#150), not a fully supported path yet.
 */
export function defaultShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === "win32") return process.env.ComSpec || "cmd.exe";
  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "/bin/sh";
}

/**
 * Extra `bin` directories to prepend to `PATH` so subprocesses (git, gh,
 * setup scripts, cloudflared) still resolve system tools when the server
 * was launched from a GUI/service with a stripped-down `PATH`.
 *
 * - macOS: Homebrew's Apple-Silicon (`/opt/homebrew/bin`) and Intel/general
 *   (`/usr/local/bin`) prefixes.
 * - Linux: `/usr/local/bin`, plus Linuxbrew (`/home/linuxbrew/.linuxbrew/bin`)
 *   only when it actually exists — a stock host has neither Homebrew nor
 *   that directory, so we must not blindly prepend a nonexistent path.
 * - Windows: none yet (tracked in #150).
 *
 * Memoized: `process.platform` and the Linuxbrew directory's existence are
 * stable for the process lifetime, so the `existsSync` probe runs once
 * rather than on every `gitCmd()` / `execGh()` / setup / teardown call that
 * prepends the PATH (mirrors the `cachedShellPath` cache below).
 */
let cachedBinDirs: readonly string[] | null = null;

export function extraBinDirs(): readonly string[] {
  if (cachedBinDirs) return cachedBinDirs;
  if (process.platform === "darwin") {
    cachedBinDirs = ["/opt/homebrew/bin", "/usr/local/bin"];
  } else if (process.platform === "linux") {
    const dirs: string[] = [];
    const linuxbrew = "/home/linuxbrew/.linuxbrew/bin";
    if (existsSync(linuxbrew)) dirs.push(linuxbrew);
    dirs.push("/usr/local/bin");
    cachedBinDirs = dirs;
  } else {
    cachedBinDirs = [];
  }
  return cachedBinDirs;
}

/**
 * Prepend `extraBinDirs()` to an existing `PATH` string, joined with the
 * platform's `path.delimiter` (`:` on POSIX, `;` on Windows). The extra
 * dirs come first so they win the shell's left-to-right PATH search;
 * returns the extra dirs alone when `path` is empty/undefined.
 */
export function prependBinDirs(path: string | undefined): string {
  return [...extraBinDirs(), ...(path ? [path] : [])].join(delimiter);
}

let cachedShellPath: string | null = null;

export async function shellPath(): Promise<string> {
  if (cachedShellPath) return cachedShellPath;

  const shell = defaultShell();
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(shell, ["-li", "-c", "echo $PATH"], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.trim());
      });
    });
    if (result) {
      cachedShellPath = result;
      return result;
    }
  } catch {
    // Fall through to default
  }

  const fallback = prependBinDirs(process.env.PATH);
  cachedShellPath = fallback;
  return fallback;
}

/** Resolve a binary against the user's interactive `$PATH`, or `null` when absent. */
export async function whichBinary(name: string): Promise<string | null> {
  const resolvedPath = await shellPath();
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile("which", [name], { env: { ...process.env, PATH: resolvedPath } }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.trim());
      });
    });
    return result || null;
  } catch {
    return null;
  }
}
