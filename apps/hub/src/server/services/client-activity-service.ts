import { createLogger } from "@band-app/logger";

const log = createLogger("client-activity");

/** How actively a client looks at Band. The branch-status poller picks its cadence from the most active live client. */
export type ClientActivity = "active" | "idle" | "background";

const RANK: Record<ClientActivity, number> = { background: 0, idle: 1, active: 2 };

/** A client that has not reported for this long is gone (a closed laptop, a killed app). */
const DEFAULT_TTL_MS = 3 * 60_000;
/** Reports from more distinct clients than this evict the stalest ones, so a caller cannot grow the map. */
const MAX_CLIENTS = 64;

function ttlMs(): number {
  const v = Number(process.env.BAND_ACTIVITY_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

/**
 * The level when no client reports. `idle` unless `BAND_ACTIVITY_DEFAULT` says `active` or
 * `background`: a hub nobody looks at has no reason to poll git every 5 s. The test suite sets
 * `active` so servers without a UI behave as before. Read on every call.
 */
function fallbackLevel(): ClientActivity {
  const v = process.env.BAND_ACTIVITY_DEFAULT;
  return v === "active" || v === "background" ? v : "idle";
}

interface ClientEntry {
  activity: ClientActivity;
  reportedAt: number;
}

/**
 * Remembers what each connected UI last reported. A client names only itself, so no client can
 * change another's state, and the result is never faster than `active`. With no live client the
 * level is `idle`: nobody is looking, so there is no reason to poll git every 5 s.
 */
export class ClientActivityService {
  private readonly clients = new Map<string, ClientEntry>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private listener: ((level: ClientActivity) => void) | null = null;
  private lastEffective: ClientActivity | null = null;

  /** Called whenever the effective level changes, including when a report expires. */
  onChange(listener: (level: ClientActivity) => void): void {
    this.listener = listener;
  }

  report(clientId: string, activity: ClientActivity, now = Date.now()): void {
    this.clients.delete(clientId);
    this.clients.set(clientId, { activity, reportedAt: now });
    // Over the cap, drop the least active client first (the stalest of those), so a flood of
    // `background` ids cannot push out an `active` one.
    while (this.clients.size > MAX_CLIENTS) {
      let victim: string | undefined;
      let victimRank = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.clients) {
        if (id === clientId) continue;
        if (RANK[entry.activity] < victimRank) {
          victim = id;
          victimRank = RANK[entry.activity];
        }
      }
      if (victim === undefined) break;
      this.clients.delete(victim);
    }
    this.refresh(now);
  }

  /** The client went away (page closed). */
  release(clientId: string, now = Date.now()): void {
    if (this.clients.delete(clientId)) this.refresh(now);
  }

  /** The most active level among clients that reported within the TTL, else the fallback (`idle`). */
  effective(now = Date.now()): ClientActivity {
    const ttl = ttlMs();
    let best: ClientActivity | null = null;
    for (const [id, entry] of this.clients) {
      if (now - entry.reportedAt >= ttl) {
        this.clients.delete(id);
        continue;
      }
      if (best === null || RANK[entry.activity] > RANK[best]) best = entry.activity;
    }
    return best ?? fallbackLevel();
  }

  /**
   * How many 3 s title-poll ticks to wait between polls: every tick while a UI is active, every
   * fifth while the best one is idle, none while there is no live client or all are in the background.
   */
  titlePollEvery(now = Date.now()): number {
    const level = this.effective(now);
    if (level === "background") return 0;
    // With no live client the fallback level decides (idle unless `BAND_ACTIVITY_DEFAULT` says otherwise).
    if (this.clients.size === 0 && level === "idle") return 0;
    return level === "active" ? 1 : 5;
  }

  /** Forget everything (tests, shutdown). */
  reset(): void {
    this.clients.clear();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.lastEffective = null;
  }

  private refresh(now: number): void {
    const level = this.effective(now);
    if (level !== this.lastEffective) {
      this.lastEffective = level;
      log.debug({ level, clients: this.clients.size }, "effective activity changed");
      this.listener?.(level);
    }
    this.armExpiry(now);
  }

  /** One timer for the earliest expiry, so a silent client drops out without anyone polling. */
  private armExpiry(now: number): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.clients.size === 0) return;
    const ttl = ttlMs();
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.clients.values())
      earliest = Math.min(earliest, entry.reportedAt + ttl);
    const delay = Math.max(50, earliest - now + 10);
    this.expiryTimer = setTimeout(() => this.refresh(Date.now()), delay);
    this.expiryTimer.unref();
  }
}

export const clientActivityService = new ClientActivityService();
