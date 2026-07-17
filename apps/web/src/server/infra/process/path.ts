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

/**
 * Build the argv to run a shell *command string* (the `sh -c "<command>"`
 * shape used by the `.band` setup/teardown hooks) cross-platform.
 *
 * POSIX keeps the historical `bash -c <command>` so user-authored setup
 * commands (which are written as bash) behave exactly as before. Windows
 * has no bash on a stock host, so route the command through the command
 * interpreter (`%ComSpec%`, i.e. cmd.exe) with `/d /s /c` — `/d` skips
 * AutoRun, `/s` fixes quote handling, `/c` runs the string and exits.
 */
export function shellCommandInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: "bash", args: ["-c", command] };
}

/**
 * Build the argv to execute a script *file* by path cross-platform.
 *
 * POSIX runs it via `bash <scriptPath>` (the file is interpreted as a bash
 * script regardless of its executable bit). Windows has no bash on a stock
 * host, so hand the path to the command interpreter — a `.cmd`/`.bat`
 * runs directly; a bash-shaped script won't execute correctly, but the
 * interpreter always exists so the call never ENOENTs on a missing `bash`.
 */
export function scriptInvocation(scriptPath: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", scriptPath] };
  }
  return { file: "bash", args: [scriptPath] };
}

let cachedShellPath: string | null = null;

export async function shellPath(): Promise<string> {
  if (cachedShellPath) return cachedShellPath;

  // Windows has no POSIX login shell to interrogate — cmd.exe/PowerShell
  // don't understand `-li -c 'echo $PATH'`. The process already inherits
  // the user's `PATH` from the environment, so use it directly.
  // `extraBinDirs()` is empty on Windows, so `prependBinDirs` is a
  // passthrough that just normalises an undefined `PATH` to "".
  if (process.platform === "win32") {
    cachedShellPath = prependBinDirs(process.env.PATH);
    return cachedShellPath;
  }

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
  // `which` is POSIX-only; Windows ships `where.exe`, which prints one
  // absolute match per line (resolving against `PATHEXT`, so a bare name
  // like `claude` finds `claude.cmd`/`claude.exe`).
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(locator, [name], { env: { ...process.env, PATH: resolvedPath } }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.trim());
      });
    });
    // `where` can return several lines (one per match); take the first.
    const first = result.split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}
