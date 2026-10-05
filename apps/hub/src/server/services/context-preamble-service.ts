/**
 * Builds the preamble a chat's agent starts with (plan step 5.3): the user's
 * preferences, the notes of the project contexts that list the chat's repo, and
 * an index of what else exists. The host reads its own working copies
 * (`host.context.preamble`), so a worker's files never reach the hub except as
 * this text. A context with its `preamble` flag off turns the whole preamble
 * off for the session. Never throws: no preamble beats a chat that won't start.
 */

import { createLogger } from "@band-app/logger";
import type { SessionPreamble } from "./_utils/preamble-injection";
import { contextSyncService } from "./context-sync-service";

const log = createLogger("context-preamble");

export class ContextPreambleService {
  async forWorktree(worktreeId: string): Promise<SessionPreamble | null> {
    try {
      const target = await contextSyncService.contextsFor(worktreeId);
      if (!target || target.specs.length === 0) return null;
      if (target.rows.some((row) => !row.preamble)) return null;
      const preamble = await target.host.context.preamble({ contexts: target.specs });
      return preamble.text || preamble.memoryDir ? preamble : null;
    } catch (err) {
      log.warn({ worktreeId, err }, "could not build the context preamble, starting without it");
      return null;
    }
  }
}

export const contextPreambleService = new ContextPreambleService();
