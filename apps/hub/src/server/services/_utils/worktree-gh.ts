/**
 * `gh` calls for a worktree's review and checks, run where the worktree lives.
 *
 * The worktree's host answers first, so the Checks panel reads the same `gh` login as the branch
 * status poller that draws the sidebar badge. When that host cannot answer (offline, `gh` missing
 * or not logged in), the hub's own `gh` runs with the vault token (`hub-gh-auth`). When both fail,
 * the error names each machine and the fix.
 */

import { tmpdir } from "node:os";
import { type Host, HostOfflineError } from "@band-app/host-api";
import { execGh } from "@band-app/host-local/git/git-client";
import { hubGhEnv, withHubGhCredential } from "./hub-gh-auth";

/** The `gh` subcommands a review provider needs: GraphQL reads and a PR merge. */
function allowed(args: string[]): boolean {
  return (args[0] === "api" && args[1] === "graphql") || (args[0] === "pr" && args[1] === "merge");
}

/** What `gh` prints when it is not logged in, or cannot be found. */
const UNAUTHENTICATED =
  /gh auth login|GH_TOKEN|GITHUB_TOKEN|authentication|HTTP 401|bad credentials/i;
const MISSING_GH = /ENOENT|command not found|executable file not found|no such file/i;

/** The limit the provider's own `gh` calls had before they ran through the host. */
const GH_TIMEOUT_MS = 30_000;

function withTimeout<T>(run: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("gh timed out")), GH_TIMEOUT_MS);
  });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

/** True for a failure that another machine's `gh` might not share. */
function hostCannotAnswer(err: unknown): boolean {
  if (err instanceof HostOfflineError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return UNAUTHENTICATED.test(message) || MISSING_GH.test(message);
}

/** Runs the hub's `gh`, with stderr trimmed as `host.exec` trims it. */
async function runHubGh(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  try {
    return await execGh(args, cwd, { GH_PROMPT_DISABLED: "1", ...env });
  } catch (err) {
    if (err instanceof Error) err.message = err.message.trim();
    throw err;
  }
}

/** The hub is the worktree's host: gh's own error stands, with the vault token as a fallback login. */
async function localGh(args: string[], cwd: string): Promise<string> {
  return runHubGh(args, cwd, await hubGhEnv());
}

/** The hub as a fallback for a worker: a missing credential adds the vault fix to gh's message. */
function fallbackGh(args: string[], cwd: string): Promise<string> {
  return withHubGhCredential((env) => runHubGh(args, cwd, env));
}

export function worktreeGh(
  host: Host,
  localHostId: string,
  cwd: string,
): (args: string[]) => Promise<string> {
  return async (args) => {
    if (!allowed(args)) throw new Error(`gh ${args.slice(0, 2).join(" ")} is not allowed here`);
    if (host.id === localHostId) return withTimeout(localGh(args, cwd));
    let hostError: unknown;
    try {
      return (await withTimeout(host.git.gh(args, cwd))).stdout;
    } catch (err) {
      if (err instanceof Error) err.message = err.message.trim();
      if (!hostCannotAnswer(err)) throw err;
      hostError = err;
    }
    try {
      return await withTimeout(fallbackGh(args, tmpdir()));
    } catch (hubError) {
      if (!hostCannotAnswer(hubError)) throw hubError;
      throw new Error(
        `GitHub is not reachable with gh. Worker ${host.id}: ${firstLine(hostError)}. ` +
          `Hub: ${firstLine(hubError)}. Fix: run gh auth login on ${host.id}, or store a GitHub ` +
          "token on the hub with band vault put --kind git --host github.com.",
      );
    }
  };
}
