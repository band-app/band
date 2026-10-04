/**
 * Persistence for `tokens`. Rows hold the SHA-256 hash of a token, never the
 * token. Statements that change state are guarded in SQL (`revoked_at IS
 * NULL`), so two callers racing for one row can't both win.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../connection";
import { hosts, tokens } from "../schema";

export type TokenRow = typeof tokens.$inferSelect;
export type TokenKind = TokenRow["kind"];
export type HostRow = typeof hosts.$inferSelect;

export class TokenQueries {
  findByHash(hash: string): TokenRow | undefined {
    return getDb().select().from(tokens).where(eq(tokens.hash, hash)).get();
  }

  findById(id: string): TokenRow | undefined {
    return getDb().select().from(tokens).where(eq(tokens.id, id)).get();
  }

  list(): TokenRow[] {
    return getDb().select().from(tokens).orderBy(desc(tokens.createdAt)).all();
  }

  insert(row: TokenRow): void {
    getDb().insert(tokens).values(row).run();
  }

  /** Sets the hash of `id` and clears its revocation. Used to follow `settings.tokenSecret`. */
  replaceHash(id: string, hash: string): void {
    getDb().update(tokens).set({ hash, revokedAt: null }).where(eq(tokens.id, id)).run();
  }

  touch(id: string, at: number): void {
    getDb().update(tokens).set({ lastUsedAt: at }).where(eq(tokens.id, id)).run();
  }

  /** Marks a live bootstrap token as spent. Returns whether this call spent it. */
  consumeBootstrap(id: string, at: number): boolean {
    const result = getDb()
      .update(tokens)
      .set({ revokedAt: at, lastUsedAt: at })
      .where(and(eq(tokens.id, id), isNull(tokens.revokedAt)))
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Spends a bootstrap token and inserts the session row in one transaction,
   * so a failed insert doesn't burn the token. Returns whether this call won.
   */
  exchangeBootstrap(id: string, at: number, session: TokenRow): boolean {
    return getDb().transaction((tx) => {
      const result = tx
        .update(tokens)
        .set({ revokedAt: at, lastUsedAt: at })
        .where(and(eq(tokens.id, id), isNull(tokens.revokedAt)))
        .run();
      if (Number(result.changes ?? 0) === 0) return false;
      tx.insert(tokens).values(session).run();
      return true;
    });
  }

  /** Revokes a live token. Returns whether this call did it. */
  revoke(id: string, at: number): boolean {
    const result = getDb()
      .update(tokens)
      .set({ revokedAt: at })
      .where(and(eq(tokens.id, id), isNull(tokens.revokedAt)))
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Revokes every live token of a host. */
  revokeForHost(hostId: string, at: number): void {
    getDb()
      .update(tokens)
      .set({ revokedAt: at })
      .where(and(eq(tokens.hostId, hostId), isNull(tokens.revokedAt)))
      .run();
  }

  findHost(id: string): HostRow | undefined {
    return getDb().select().from(hosts).where(eq(hosts.id, id)).get();
  }

  listHosts(): HostRow[] {
    return getDb().select().from(hosts).orderBy(hosts.createdAt).all();
  }

  markHostSeen(id: string, at: number): void {
    getDb().update(hosts).set({ lastSeenAt: at, status: "online" }).where(eq(hosts.id, id)).run();
  }

  insertHost(row: HostRow): void {
    getDb().insert(hosts).values(row).run();
  }
}
