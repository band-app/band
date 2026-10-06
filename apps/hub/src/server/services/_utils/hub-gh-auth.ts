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
  "No GitHub credential for gh on this hub: run gh auth login, or store one with band vault put --kind git --host github.com";

/** What gh prints when it has no usable login (`gh auth login`, `GH_TOKEN`, a 401). */
const UNAUTHENTICATED =
  /gh auth login|GH_TOKEN|GITHUB_TOKEN|authentication|HTTP 401|bad credentials/i;

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
 * Runs a hub `gh` call and, when it fails because gh is unauthenticated and no credential is
 * available, adds the missing credential to gh's own message. Other failures pass through
 * unchanged. The error never holds a token.
 */
export async function withHubGhCredential<T>(
  run: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const env = await hubGhEnv();
  try {
    return await run(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      env.GH_TOKEN === undefined &&
      UNAUTHENTICATED.test(message) &&
      (await hubGhHasNoCredential())
    ) {
      throw new Error(`${message.split("\n")[0]} (${MISSING_GH_CREDENTIAL})`);
    }
    throw err;
  }
}
