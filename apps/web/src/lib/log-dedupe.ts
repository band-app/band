/**
 * Simple per-key throttle for repetitive log lines.
 *
 * Motivation: the CI poller's GraphQL error path used to fire once per host
 * per tick (every 30 s by default), which produced ~120 identical
 * "GraphQL query failed for host …" lines per hour in `~/.band/server.log`.
 * That noise made the log essentially unreadable while we investigated
 * issue #457.
 *
 * `LogThrottle` lets the caller emit the first occurrence of a given key
 * at full fidelity and silently drop subsequent occurrences until the TTL
 * expires. Use a stable composite key (e.g. `${host}:${errorMessage}`) so
 * different failure modes still get one line each, but a single recurring
 * failure isn't repeated.
 *
 * Bounded memory: the map is capped at `maxEntries` (default 1000); the
 * oldest entry is evicted FIFO once the cap is reached so a stream of
 * unique keys can't grow the map without bound.
 */
export class LogThrottle {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly lastSeen = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    opts: { ttlMs: number; maxEntries?: number; now?: () => number } = { ttlMs: 60_000 },
  ) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 1000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Returns `true` the first time `key` is seen, or after the configured
   * TTL has elapsed since the last time it was reported. Otherwise returns
   * `false` and the caller should suppress the log line.
   */
  shouldLog(key: string): boolean {
    const now = this.now();
    const last = this.lastSeen.get(key);
    if (last !== undefined && now - last < this.ttlMs) {
      return false;
    }
    // Re-insertion bumps the key to the end of `Map`'s insertion order, which
    // we rely on for FIFO eviction below.
    this.lastSeen.delete(key);
    this.lastSeen.set(key, now);

    if (this.lastSeen.size > this.maxEntries) {
      const oldest = this.lastSeen.keys().next();
      if (!oldest.done) {
        this.lastSeen.delete(oldest.value);
      }
    }
    return true;
  }

  /** Forget every recorded key. Test helper. */
  reset(): void {
    this.lastSeen.clear();
  }

  /** Number of keys currently tracked. Test helper. */
  size(): number {
    return this.lastSeen.size;
  }
}
