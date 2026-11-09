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
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { agentSessions } from "../schema";

export type AgentSessionPatch = Partial<
  Pick<AgentSessionRecord, "providerSessionId" | "state" | "chatId" | "terminalId" | "endReason">
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

  deleteForWorktree(worktreeId: string): void {
    getDb().delete(agentSessions).where(eq(agentSessions.worktreeId, worktreeId)).run();
  }
}
