/**
 * Persistence for agent sessions (issue #682): one row per run of a coding
 * agent in a chat pane or a terminal. Business rules (which row a chat or
 * terminal event updates, the lifecycle events) live in
 * `services/agent-session-registry-service.ts`.
 */

import type { AgentSessionRecord } from "@band-app/shared/agent-sessions";
import { and, asc, eq, ne } from "drizzle-orm";
import { getDb } from "../connection";
import { agentSessions } from "../schema";

export type AgentSessionPatch = Partial<
  Pick<AgentSessionRecord, "providerSessionId" | "state" | "chatId" | "terminalId">
> & { updatedAt: number };

export class AgentSessionQueries {
  insert(row: AgentSessionRecord): void {
    getDb().insert(agentSessions).values(row).run();
  }

  find(id: string): AgentSessionRecord | undefined {
    return getDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  }

  update(id: string, patch: AgentSessionPatch): AgentSessionRecord | undefined {
    getDb().update(agentSessions).set(patch).where(eq(agentSessions.id, id)).run();
    return this.find(id);
  }

  /** Sessions of a workspace that haven't ended, oldest first. */
  findOpenByWorkspace(workspaceId: string): AgentSessionRecord[] {
    return getDb()
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.workspaceId, workspaceId), ne(agentSessions.state, "ended")))
      .orderBy(asc(agentSessions.createdAt))
      .all();
  }

  /** The session currently running in a chat pane, if any. */
  findOpenByChat(chatId: string): AgentSessionRecord | undefined {
    return getDb()
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.chatId, chatId), ne(agentSessions.state, "ended")))
      .get();
  }

  /** The session currently running in a terminal, if any. */
  findOpenByTerminal(terminalId: string): AgentSessionRecord | undefined {
    return getDb()
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.terminalId, terminalId), ne(agentSessions.state, "ended")))
      .get();
  }

  deleteForWorkspace(workspaceId: string): void {
    getDb().delete(agentSessions).where(eq(agentSessions.workspaceId, workspaceId)).run();
  }
}
