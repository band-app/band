import { execFile } from "node:child_process";

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
 * Extracted from `lib/process-utils.ts` (and then `services/system-service.ts`)
 * to fix the Tier 3 → Tier 2 layering violation flagged in the Phase 7.5
 * review (issue #517).
 */

let cachedShellPath: string | null = null;

export async function shellPath(): Promise<string> {
  if (cachedShellPath) return cachedShellPath;

  const shell = process.env.SHELL || "/bin/zsh";
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

  const fallback = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`;
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
