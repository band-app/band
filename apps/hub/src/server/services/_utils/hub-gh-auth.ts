/**
 * Credentials for the `gh` calls the hub makes itself (the GitHub poll and webhook services).
 *
 * A hub on a developer machine uses the machine's own `gh auth login`. A hub in a container has
 * none, so `gh` runs with `GH_TOKEN` taken from the vault (a `git` item for github.com). The token
 * lives only in the child process's environment.
 */

import { tmpdir } from "node:os";
import { execGh } from "@band-app/host-local/git/git-client";
import { vaultService } from "../vault-service";

const LOGIN_CHECK_TTL_MS = 60_000;

export const MISSING_GH_CREDENTIAL =
  "No GitHub credential for gh on this hub. Run `gh auth login` on the hub's machine, or store a token with `band vault put <name> --kind git --host github.com --path '<owner>/*'` (scopes: repo, read:org, admin:repo_hook for webhooks).";

let loginCheck: { at: number; loggedIn: boolean } | null = null;

/** Whether the machine's `gh` has a login (or `GH_TOKEN` is set), cached for a minute. */
async function machineHasLogin(): Promise<boolean> {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
  const now = Date.now();
  if (loginCheck && now - loginCheck.at < LOGIN_CHECK_TTL_MS) return loginCheck.loggedIn;
  let loggedIn = false;
  try {
    await execGh(["auth", "status", "--hostname", "github.com"], tmpdir());
    loggedIn = true;
  } catch {
    loggedIn = false;
  }
  loginCheck = { at: now, loggedIn };
  return loggedIn;
}

/** The extra environment for a hub `gh` call: `GH_TOKEN` from the vault when the machine has no login. */
export async function hubGhEnv(): Promise<Record<string, string>> {
  if (await machineHasLogin()) return {};
  const token = vaultService.findGitHubToken();
  return token ? { GH_TOKEN: token } : {};
}

/** True when a `gh` call would run with no login and no vault token. */
export async function hubGhHasNoCredential(): Promise<boolean> {
  return !(await machineHasLogin()) && vaultService.findGitHubToken() === undefined;
}

/** Forgets the cached login check. For tests that change the machine's login. */
export function resetHubGhAuthCache(): void {
  loginCheck = null;
}

/**
 * Runs a hub `gh` call and, when it fails with no credential available, names the missing
 * credential instead of passing on gh's own message. The error never holds a token.
 */
export async function withHubGhCredential<T>(
  run: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const env = await hubGhEnv();
  try {
    return await run(env);
  } catch (err) {
    if (env.GH_TOKEN === undefined && (await hubGhHasNoCredential())) {
      throw new Error(`${MISSING_GH_CREDENTIAL} (${firstLine(err)})`);
    }
    throw err;
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}
