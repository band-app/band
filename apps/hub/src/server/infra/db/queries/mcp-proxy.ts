/**
 * Persistence for `mcp_servers`, `mcp_proxy_tokens` and `mcp_proxy_audit`.
 * Token rows hold the SHA-256 of a token, never the token. Only
 * `McpProxyService` calls this.
 */

import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { mcpProxyAudit, mcpProxyTokens, mcpServers } from "../schema";

export type McpServerRow = typeof mcpServers.$inferSelect;
export type McpProxyTokenRow = typeof mcpProxyTokens.$inferSelect;
export type McpAuditRow = typeof mcpProxyAudit.$inferSelect;

export class McpProxyQueries {
  // ---- servers ------------------------------------------------------------------

  listServers(): McpServerRow[] {
    return getDb().select().from(mcpServers).orderBy(asc(mcpServers.createdAt)).all();
  }

  findServer(name: string): McpServerRow | undefined {
    return getDb().select().from(mcpServers).where(eq(mcpServers.name, name)).get();
  }

  insertServer(row: McpServerRow): void {
    getDb().insert(mcpServers).values(row).run();
  }

  updateServer(name: string, patch: Partial<Omit<McpServerRow, "id" | "name">>): void {
    getDb().update(mcpServers).set(patch).where(eq(mcpServers.name, name)).run();
  }

  removeServer(name: string): boolean {
    const result = getDb().delete(mcpServers).where(eq(mcpServers.name, name)).run();
    return Number(result.changes ?? 0) > 0;
  }

  // ---- tokens -------------------------------------------------------------------

  insertToken(row: McpProxyTokenRow): void {
    getDb().insert(mcpProxyTokens).values(row).run();
  }

  findTokenByHash(hash: string): McpProxyTokenRow | undefined {
    return getDb().select().from(mcpProxyTokens).where(eq(mcpProxyTokens.hash, hash)).get();
  }

  touchToken(id: string, at: number): void {
    getDb().update(mcpProxyTokens).set({ lastUsedAt: at }).where(eq(mcpProxyTokens.id, id)).run();
  }

  /** Revokes every live token of a session. Returns how many it revoked. */
  revokeSession(sessionId: string, at: number): number {
    const result = getDb()
      .update(mcpProxyTokens)
      .set({ revokedAt: at })
      .where(and(eq(mcpProxyTokens.sessionId, sessionId), isNull(mcpProxyTokens.revokedAt)))
      .run();
    return Number(result.changes ?? 0);
  }

  /** Takes a server name off every live token, so a server later added under that name is not reachable by them. */
  dropServerFromTokens(name: string, at: number): void {
    const live = getDb()
      .select()
      .from(mcpProxyTokens)
      .where(isNull(mcpProxyTokens.revokedAt))
      .all();
    for (const row of live) {
      if (!row.servers.includes(name)) continue;
      const servers = row.servers.filter((s) => s !== name);
      getDb()
        .update(mcpProxyTokens)
        .set(servers.length > 0 ? { servers } : { servers, revokedAt: at })
        .where(eq(mcpProxyTokens.id, row.id))
        .run();
    }
  }

  /** Deletes tokens that expired or were revoked before `before`. */
  deleteDeadTokens(before: number): void {
    getDb()
      .delete(mcpProxyTokens)
      .where(
        sql`${mcpProxyTokens.expiresAt} < ${before} OR (${mcpProxyTokens.revokedAt} IS NOT NULL AND ${mcpProxyTokens.revokedAt} < ${before})`,
      )
      .run();
  }

  // ---- audit --------------------------------------------------------------------

  insertAudit(row: Omit<McpAuditRow, "id">): void {
    getDb().insert(mcpProxyAudit).values(row).run();
  }

  listAudit(limit: number, server?: string, offset = 0): McpAuditRow[] {
    const query = getDb().select().from(mcpProxyAudit);
    return (server ? query.where(eq(mcpProxyAudit.server, server)) : query)
      .orderBy(desc(mcpProxyAudit.id))
      .limit(limit)
      .offset(offset)
      .all();
  }

  /** Drops audit rows older than `before`. */
  pruneAudit(before: number): void {
    getDb().delete(mcpProxyAudit).where(lt(mcpProxyAudit.at, before)).run();
  }
}
