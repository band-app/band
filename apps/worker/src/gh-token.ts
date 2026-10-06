/**
 * The token for `gh` in the processes this worker starts (agents and terminals).
 *
 * The hub hands it out over the link (`gh.token`) to a worker a runner started, or to one whose
 * operator set `BAND_WORKER_GH_TOKEN=hub`. The worker keeps it nowhere: each spawn asks again and
 * puts `GH_TOKEN` in that child's environment only. A worker whose own environment already has a
 * token keeps it, and an attached worker with its own `gh auth login` is not asked.
 */

import { type GhTokenParams, type GhTokenReply, METHOD_GH_TOKEN } from "@band-app/link";
import type { WorkerContext } from "./context.ts";

const HUB_ANSWER_MS = 15_000;

/** `GH_TOKEN` for a child process's environment, or an empty object when there is none to give. */
export async function ghTokenEnv(
  ctx: WorkerContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return {};
  const params: GhTokenParams = env.BAND_WORKER_GH_TOKEN === "hub" ? { optIn: true } : {};
  try {
    const reply = await ctx.session.request<GhTokenReply>(METHOD_GH_TOKEN, params, {
      timeoutMs: HUB_ANSWER_MS,
    });
    if (reply.found) return { GH_TOKEN: reply.token };
    if (reply.reason?.startsWith("no ")) {
      ctx.log.warn({ reason: reply.reason }, "no GitHub token for gh from the hub");
    }
  } catch (err) {
    // The message only: it never holds a token.
    ctx.log.warn(
      { message: err instanceof Error ? err.message : String(err) },
      "could not ask the hub for a GitHub token",
    );
  }
  return {};
}
