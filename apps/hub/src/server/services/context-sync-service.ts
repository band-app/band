/**
 * Keeps the context working copies on a host in step with the hub (plan step
 * 5.2). Before an agent session starts, `pullForWorktree` brings the user
 * context and the session's project contexts to the hub's head, with a short
 * timeout: a host the hub cannot reach in time starts the session on the copy
 * it already has. After each turn, `pushAfterTurn` has the host commit what the
 * agent changed, scan it for secrets, rebase it on the hub's head and push.
 *
 * The host does the git work (`host.context`), on its own disk, so the hub
 * never reads a worker's files. The hub chooses the contexts (user context,
 * plus project contexts that list the session's repo and whose labels the host
 * carries), sends vault fingerprints for the scan, and records what the host
 * reports: a kept-both conflict, or files the scan held back.
 */

import type { ContextPushResult, ContextSpec } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { contextService } from "./context-service";
import { tokenService } from "./token-service";
import { vaultService } from "./vault-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("context-sync");

const LOCAL_HOST_ID = "local";
const DEFAULT_PULL_TIMEOUT_MS = 10_000;

function pullTimeoutMs(): number {
  return Number(process.env.BAND_CONTEXT_PULL_TIMEOUT_MS) || DEFAULT_PULL_TIMEOUT_MS;
}

export class ContextSyncService {
  /** The contexts a worktree's host may hold for its session, and the host that holds them. */
  private async specsFor(worktreeId: string) {
    const worktree = worktreeService.resolve(worktreeId);
    if (!worktree) return null;
    const host = worktree.host;
    const labels =
      host.id === LOCAL_HOST_ID
        ? ((await host.info().catch(() => null))?.labels ?? [])
        : (tokenService.hostLabels(host.id) ?? []);
    const rows = contextService.forSession(worktree.repo.name, labels);
    const specs: ContextSpec[] = rows.map((row) => ({ name: row.name, kind: row.kind }));
    const readOnly = new Set(rows.filter((r) => r.workerAccess === "read-only").map((r) => r.name));
    return { host, specs, readOnly };
  }

  /**
   * Pulls before a session starts. Never throws: a failed or slow pull leaves the host's copy
   * as it was, and the session starts anyway.
   */
  async pullForWorktree(worktreeId: string): Promise<void> {
    try {
      const target = await this.specsFor(worktreeId);
      if (!target || target.specs.length === 0) return;
      const results = await target.host.context.pull({
        contexts: target.specs,
        timeoutMs: pullTimeoutMs(),
      });
      for (const r of results) {
        if (r.status === "stale" || r.status === "missing" || r.status === "denied") {
          log.warn(
            { worktreeId, context: r.name, status: r.status, error: r.error },
            "context pull did not finish, starting the session on the existing copy",
          );
        }
      }
    } catch (err) {
      log.warn(
        { worktreeId, err },
        "context pull failed, starting the session on the existing copy",
      );
    }
  }

  /** Pushes after a turn. Never throws. Resolves with what the host reported. */
  async pushAfterTurn(
    worktreeId: string,
    chatId: string,
    turn: number,
  ): Promise<ContextPushResult[]> {
    try {
      const target = await this.specsFor(worktreeId);
      if (!target || target.specs.length === 0) return [];
      const { readOnly } = target;
      const hostId = target.host.id;
      // The hub's own host writes the bare repo by path, so honor read-only here.
      const writable = target.specs.filter(
        (s) => target.host.id !== LOCAL_HOST_ID || !readOnly.has(s.name),
      );
      if (writable.length === 0) return [];
      const results = await target.host.context.push({
        contexts: writable,
        message: `agent ${chatId} turn ${turn}`,
        hostLabel: hostId,
        secrets: vaultService.secretFingerprints(),
      });
      for (const r of results) {
        if (r.conflicts.length > 0) {
          contextService.recordEvent(r.name, hostId, "conflict", {
            chatId,
            conflicts: r.conflicts,
          });
        }
        if (r.blocked.length > 0) {
          // Rules and line numbers only: the matched text never leaves the host.
          contextService.recordEvent(r.name, hostId, "blocked", {
            chatId,
            findings: r.blocked,
            quarantine: r.quarantine,
          });
        }
        if (r.status === "pushed") contextService.syncSoon(r.name);
        if (r.status === "failed") {
          log.warn({ context: r.name, hostId, error: r.error }, "context push failed");
        }
      }
      return results;
    } catch (err) {
      log.warn({ worktreeId, chatId, err }, "context push failed");
      return [];
    }
  }
}

export const contextSyncService = new ContextSyncService();
