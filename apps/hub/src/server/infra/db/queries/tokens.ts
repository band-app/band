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

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update">;

export class TokenQueries {
  constructor(private readonly db: () => Db = getDb) {}

  findByHash(hash: string): TokenRow | undefined {
    return this.db().select().from(tokens).where(eq(tokens.hash, hash)).get();
  }

  findById(id: string): TokenRow | undefined {
    return this.db().select().from(tokens).where(eq(tokens.id, id)).get();
  }

  list(limit: number): TokenRow[] {
    return this.db().select().from(tokens).orderBy(desc(tokens.createdAt)).limit(limit).all();
  }

  insert(row: TokenRow): void {
    this.db().insert(tokens).values(row).run();
  }

  /** Sets the hash of `id` and clears its revocation. Used to follow `settings.tokenSecret`. */
  replaceHash(id: string, hash: string): void {
    this.db().update(tokens).set({ hash, revokedAt: null }).where(eq(tokens.id, id)).run();
  }

  touch(id: string, at: number): void {
    this.db().update(tokens).set({ lastUsedAt: at }).where(eq(tokens.id, id)).run();
  }

  /** Marks a live bootstrap token as spent. Returns whether this call spent it. */
  spendBootstrap(id: string, at: number): boolean {
    const result = this.db()
      .update(tokens)
      .set({ revokedAt: at, lastUsedAt: at })
      .where(and(eq(tokens.id, id), isNull(tokens.revokedAt)))
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Runs `fn` in one SQLite transaction. The queries it receives share the
   * transaction, and everything rolls back if `fn` throws.
   */
  transaction<T>(fn: (queries: TokenQueries) => T): T {
    // The sync driver rejects async callbacks at the type level; `fn` is sync.
    return getDb().transaction((tx) => fn(new TokenQueries(() => tx)) as never) as T;
  }

  /** Revokes a live token. Returns whether this call did it. */
  revoke(id: string, at: number): boolean {
    const result = this.db()
      .update(tokens)
      .set({ revokedAt: at })
      .where(and(eq(tokens.id, id), isNull(tokens.revokedAt)))
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  listHosts(limit: number): HostRow[] {
    return this.db().select().from(hosts).orderBy(hosts.createdAt).limit(limit).all();
  }

  markHostSeen(id: string, at: number): void {
    this.db().update(hosts).set({ lastSeenAt: at, status: "online" }).where(eq(hosts.id, id)).run();
  }

  insertHost(row: HostRow): void {
    this.db().insert(hosts).values(row).run();
  }
}
