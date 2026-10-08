/**
 * Persistence for `tokens`. Rows hold the SHA-256 hash of a token, never the
 * token. Statements that change state are guarded in SQL (`revoked_at IS
 * NULL`), so two callers racing for one row can't both win.
 */

import { and, count, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../connection";
import { hosts, tokens, worktrees } from "../schema";

export type TokenRow = typeof tokens.$inferSelect;
export type TokenKind = TokenRow["kind"];
export type HostRow = typeof hosts.$inferSelect;

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update" | "delete">;

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

  /** Points the shared-token row at `hash`, live and admin. Used to follow `settings.tokenSecret`. */
  resetShared(id: string, hash: string): void {
    this.db()
      .update(tokens)
      .set({ hash, revokedAt: null, admin: true })
      .where(eq(tokens.id, id))
      .run();
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

  /**
   * Records that the worker presented a valid credential. Its status is not
   * touched: the worker link sets `online` once the link is up and the host's
   * info is stored.
   */
  markHostSeen(id: string, at: number): void {
    this.db().update(hosts).set({ lastSeenAt: at }).where(eq(hosts.id, id)).run();
  }

  findHost(id: string): HostRow | undefined {
    return this.db().select().from(hosts).where(eq(hosts.id, id)).get();
  }

  /** Records what a worker said when it connected: it is online, with its facts and build. */
  markHostOnline(
    id: string,
    at: number,
    fields: { info: Record<string, unknown> | null; version: string | null },
  ): void {
    this.db()
      .update(hosts)
      .set({ status: "online", lastSeenAt: at, info: fields.info, version: fields.version })
      .where(eq(hosts.id, id))
      .run();
  }

  /** Replaces what a host reported about itself, without touching its status. */
  setHostInfo(id: string, info: Record<string, unknown>): void {
    this.db().update(hosts).set({ info }).where(eq(hosts.id, id)).run();
  }

  /** Sets a host's status and, when the worker was last heard from, its last-seen time. */
  setHostStatus(id: string, status: HostRow["status"], lastSeenAt?: number): void {
    this.db()
      .update(hosts)
      .set(lastSeenAt === undefined ? { status } : { status, lastSeenAt })
      .where(eq(hosts.id, id))
      .run();
  }

  /** How many worktrees (worktree rows) live on a host. */
  countWorktreesOnHost(id: string): number {
    const row = this.db()
      .select({ n: count() })
      .from(worktrees)
      .where(eq(worktrees.hostId, id))
      .get();
    return row?.n ?? 0;
  }

  /** Live tokens bound to a host. */
  listLiveTokensForHost(id: string): TokenRow[] {
    return this.db()
      .select()
      .from(tokens)
      .where(and(eq(tokens.hostId, id), isNull(tokens.revokedAt)))
      .all();
  }

  /** Deletes a host row. Its tokens, repo paths and pending removals go with it (cascade). */
  deleteHost(id: string): void {
    this.db().delete(hosts).where(eq(hosts.id, id)).run();
  }

  insertHost(row: HostRow): void {
    this.db().insert(hosts).values(row).run();
  }
}
