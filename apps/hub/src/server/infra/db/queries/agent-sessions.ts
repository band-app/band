/**
 * Persistence for agent sessions (issue #682): one row per run of a coding
 * agent in a chat pane or a terminal. Business rules (which row a chat or
 * terminal event updates, the lifecycle events) live in
 * `services/agent-session-registry-service.ts`.
 *
 * Rows hold the SHA-256 of a TUI launch token. It never leaves this file:
 * `AgentSessionRecord` has no such field.
 */

import type { AgentSessionRecord } from "@band-app/shared/agent-sessions";
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { agentSessions } from "../schema";

export type AgentSessionPatch = Partial<
  Pick<
    AgentSessionRecord,
    | "providerSessionId"
    | "state"
    | "chatId"
    | "terminalId"
    | "endReason"
    | "status"
    | "statusUpdatedAt"
  >
> & { updatedAt: number };

type AgentSessionRow = typeof agentSessions.$inferSelect;

function toRecord(row: AgentSessionRow): AgentSessionRecord {
  const { launchTokenHash: _hash, ...record } = row;
  return record;
}

export class AgentSessionQueries {
  insert(row: AgentSessionRecord, launchTokenHash?: string): void {
    getDb()
      .insert(agentSessions)
      .values({ ...row, launchTokenHash: launchTokenHash ?? null })
      .run();
  }

  find(id: string): AgentSessionRecord | undefined {
    const row = getDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get();
    return row && toRecord(row);
  }

  /** Whether the session was launched with a token whose hash is `hash`. */
  launchTokenMatches(id: string, hash: string): boolean {
    const row = getDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get();
    return row?.launchTokenHash === hash;
  }

  /** Whether the session was launched by Band, so it expects its token. */
  hasLaunchToken(id: string): boolean {
    const row = getDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get();
    return Boolean(row?.launchTokenHash);
  }

  update(id: string, patch: AgentSessionPatch): AgentSessionRecord | undefined {
    getDb().update(agentSessions).set(patch).where(eq(agentSessions.id, id)).run();
    return this.find(id);
  }

  /** Sessions of a worktree that haven't ended, oldest first. */
  findOpenByWorktree(worktreeId: string): AgentSessionRecord[] {
    return getDb()
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.worktreeId, worktreeId), ne(agentSessions.state, "ended")))
      .orderBy(asc(agentSessions.createdAt))
      .all()
      .map(toRecord);
  }

  /** Sessions that haven't ended, in every worktree, oldest first. */
  findAllOpen(): AgentSessionRecord[] {
    return getDb()
      .select()
      .from(agentSessions)
      .where(ne(agentSessions.state, "ended"))
      .orderBy(asc(agentSessions.createdAt))
      .all()
      .map(toRecord);
  }

  /** The session currently running in a chat pane, if any. */
  findOpenByChat(chatId: string): AgentSessionRecord | undefined {
    const row = getDb()
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.chatId, chatId), ne(agentSessions.state, "ended")))
      .get();
    return row && toRecord(row);
  }

  /** The session currently running in a terminal, if any. */
  findOpenByTerminal(terminalId: string): AgentSessionRecord | undefined {
    const row = getDb()
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.terminalId, terminalId), ne(agentSessions.state, "ended")))
      .get();
    return row && toRecord(row);
  }

  /** The newest session a terminal ever had, open or not. */
  findLatestByTerminal(terminalId: string): AgentSessionRecord | undefined {
    const row = getDb()
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.terminalId, terminalId))
      .orderBy(desc(agentSessions.createdAt), desc(sql`rowid`))
      .get();
    return row && toRecord(row);
  }

  /** The open session without a terminal or chat that a hook reported under this provider id (or, with no id, this agent). */
  findOpenDetached(
    worktreeId: string,
    providerSessionId: string | null,
    agentDefinitionId: string,
  ): AgentSessionRecord | undefined {
    const row = getDb()
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.worktreeId, worktreeId),
          providerSessionId
            ? eq(agentSessions.providerSessionId, providerSessionId)
            : and(
                isNull(agentSessions.providerSessionId),
                eq(agentSessions.agentDefinitionId, agentDefinitionId),
              ),
          isNull(agentSessions.terminalId),
          isNull(agentSessions.chatId),
          ne(agentSessions.state, "ended"),
        ),
      )
      .get();
    return row && toRecord(row);
  }

  /** Set the worktree's open `done` and `failed` sessions to `idle`. Returns how many changed. */
  acknowledge(worktreeId: string, now: number): number {
    const result = getDb()
      .update(agentSessions)
      .set({ status: "idle", statusUpdatedAt: now })
      .where(
        and(
          eq(agentSessions.worktreeId, worktreeId),
          ne(agentSessions.state, "ended"),
          inArray(agentSessions.status, ["done", "failed"]),
        ),
      )
      .run();
    return Number(result.changes);
  }

  /** Hub start: every open session that is not `done` or `failed` becomes `idle`. */
  resetActiveStatuses(now: number): void {
    getDb()
      .update(agentSessions)
      .set({ status: "idle", statusUpdatedAt: now })
      .where(notInArray(agentSessions.status, ["done", "failed", "idle"]))
      .run();
  }

  /** Hub start: end terminal-less tui sessions, which nothing can show to be alive. */
  endDetached(now: number): void {
    getDb()
      .update(agentSessions)
      .set({ state: "ended", endReason: "lost", updatedAt: now })
      .where(
        and(
          eq(agentSessions.mode, "tui"),
          isNull(agentSessions.terminalId),
          isNull(agentSessions.chatId),
          ne(agentSessions.state, "ended"),
        ),
      )
      .run();
  }

  deleteForWorktree(worktreeId: string): void {
    getDb().delete(agentSessions).where(eq(agentSessions.worktreeId, worktreeId)).run();
  }
}
