import { gitRunner, type Host } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { SubscriptionQueries } from "../infra/db/queries/subscriptions";

const log = createLogger("pushed-sha");

const queries = new SubscriptionQueries();

/**
 * Records the commit a worktree's branch points at after a successful push,
 * so subscriptions can tell Band's own pushes from a human's. Never throws:
 * a missing record only means a later CI failure is treated as a human's.
 */
export async function recordPushedHead(host: Host, worktreeId: string, cwd: string): Promise<void> {
  try {
    const sha = (await gitRunner(host)(["rev-parse", "HEAD"], cwd)).trim();
    if (/^[0-9a-f]{7,64}$/i.test(sha)) queries.recordPushedSha(sha, worktreeId, Date.now());
  } catch (err) {
    log.warn({ err, worktreeId }, "could not record the pushed commit");
  }
}

/** Whether Band pushed this commit as the head of a worktree branch. */
export function isBandPushed(sha: string): boolean {
  return queries.isPushedSha(sha);
}
