import { delimiter } from "node:path";
import type { WorkerContext } from "./context.ts";
import { ghTokenEnv } from "./gh-token.ts";

/**
 * The environment of an agent this worker starts, for the hub (`acp.spawn`) or
 * for a chat it owns: the worker's `band` CLI first on PATH, so an agent's shell
 * tool finds it, and a GitHub token for `gh`.
 */
export async function agentSpawnEnv(
  ctx: WorkerContext,
  env: Record<string, string>,
  cwd?: string,
): Promise<Record<string, string>> {
  const out = { ...env };
  const cliDir = await ctx.cli?.dir();
  if (cliDir) out.PATH = [cliDir, out.PATH ?? process.env.PATH].filter(Boolean).join(delimiter);
  Object.assign(out, await ghTokenEnv(ctx));
  // Variables an extension service gives this worktree's agents (the DISPLAY of its desktop).
  const worktreeId = env.BAND_WORKTREE_ID;
  if (worktreeId && ctx.extensions) {
    Object.assign(out, await ctx.extensions.worktreeEnv(worktreeId, cwd ?? ""));
  }
  return out;
}
