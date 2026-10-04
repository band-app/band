import { gitRunner, type Host } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { SubscriptionQueries } from "../infra/db/queries/subscriptions";

const log = createLogger("pushed-sha");

const queries = new SubscriptionQueries();

/**
 * Records the commit a workspace's branch points at after a successful push,
 * so subscriptions can tell Band's own pushes from a human's. Never throws:
 * a missing record only means a later CI failure is treated as a human's.
 */
export async function recordPushedHead(
  host: Host,
  workspaceId: string,
  cwd: string,
): Promise<void> {
  try {
    const sha = (await gitRunner(host)(["rev-parse", "HEAD"], cwd)).trim();
    if (/^[0-9a-f]{7,64}$/i.test(sha)) queries.recordPushedSha(sha, workspaceId, Date.now());
  } catch (err) {
    log.warn({ err, workspaceId }, "could not record the pushed commit");
  }
}

/** Whether Band pushed this commit as the head of a workspace branch. */
export function isBandPushed(sha: string): boolean {
  return queries.isPushedSha(sha);
}
