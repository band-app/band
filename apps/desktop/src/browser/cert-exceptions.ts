/**
 * Session-scoped TLS certificate exception store.
 *
 * Backs the Chrome-style "Your connection is not private -> Advanced
 * -> Proceed to <host> (unsafe)" interstitial in `BrowserPanel.tsx`
 * (issue #444). When the user explicitly clicks Proceed for a host
 * whose certificate Chromium rejected (expired, self-signed,
 * hostname mismatch, untrusted CA), we record the
 * (partition, host, fingerprint) triple here. The per-`webContents`
 * `certificate-error` listener in `view-manager.ts` consults this
 * store and calls `callback(true)` for matches, transparently
 * allowing the load.
 *
 * Design choices (matches Chrome's behaviour):
 *
 *   - **Triple-keyed**: partition + host + fingerprint. If the cert
 *     rotates (different fingerprint, same host), the user sees the
 *     interstitial again - that's the security signal Chrome shows
 *     for the same reason.
 *   - **Session-scoped only**. The store is plain in-memory state.
 *     There is no persistence to disk. Restarting the desktop app
 *     clears every exception (acceptance criterion). Persistence
 *     with a management UI is an explicit follow-up.
 *   - **Partition-aware**. Band's browser tabs live in the dedicated
 *     `persist:band-browser` partition (see `BROWSER_PARTITION` in
 *     `view-manager.ts`), so their exceptions are keyed by that
 *     partition's `storagePath`. Keying by partition also keeps the
 *     store correct if further named partitions are ever introduced
 *     (e.g. per-workspace storage isolation).
 *   - **No global "ignore all" flag**. Per-host only by design.
 *
 * This module is intentionally pure: no Electron imports, no IPC.
 * The `BrowserViewManager` and the bootstrap glue in `main/index.ts`
 * thread an instance through. Keeps the store unit-testable under
 * `node:test` without an Electron runtime.
 */

/**
 * A normalised key for the exception store. Build via `exceptionKey`
 * so callers can't accidentally produce two different strings for
 * the same logical triple (host case, fingerprint format, etc.).
 */
export interface CertExceptionTriple {
  /** Stable identifier for the Electron Session. `"default"` for the
   *  default session; otherwise `session.storagePath` or the named
   *  partition string. */
  partition: string;
  /** Lowercased hostname from the failing URL. */
  host: string;
  /** Certificate fingerprint as Electron reports it (typically
   *  `"sha256/<hex>"`). Compared verbatim - Chromium's fingerprint
   *  format is stable across requests for the same cert. */
  fingerprint: string;
}

/**
 * Normalise a triple into the underlying map key. Lowercases the
 * host so `Example.COM` and `example.com` collapse to the same
 * entry. Fingerprint and partition are passed through verbatim
 * (Electron's fingerprint strings are already canonical, and
 * partition is opaque to us). The pipe separator is unambiguous
 * — none of the three components contain it.
 */
export function exceptionKey(triple: CertExceptionTriple): string {
  return [triple.partition, triple.host.toLowerCase(), triple.fingerprint].join("|");
}

/**
 * In-memory store of accepted exceptions. Cleared on app quit (we
 * never persist); restarting the desktop app re-prompts the user.
 *
 * The store is small (one entry per host+cert the user has explicitly
 * accepted in this session) so a plain `Set<string>` is enough.
 * No expiry - exceptions live for the lifetime of the process.
 */
export class CertExceptionStore {
  private readonly accepted = new Set<string>();

  /**
   * Record that the user has accepted this certificate for this host
   * in this session. Idempotent - re-recording the same triple is a
   * no-op (the store is a set).
   */
  add(triple: CertExceptionTriple): void {
    this.accepted.add(exceptionKey(triple));
  }

  /**
   * Is the triple currently an accepted exception? Called by the
   * per-`webContents` `certificate-error` listener (which gates
   * whether Chromium gets `callback(true)` vs the default block) and
   * by the renderer-side "Not Secure" indicator decision (which
   * highlights any host the user is currently browsing with an
   * override).
   */
  has(triple: CertExceptionTriple): boolean {
    return this.accepted.has(exceptionKey(triple));
  }

  /**
   * Drop every exception. Provided for test isolation; production
   * code relies on the process restart to clear the store.
   */
  clear(): void {
    this.accepted.clear();
  }

  /** Count of recorded exceptions. Provided for tests. */
  size(): number {
    return this.accepted.size;
  }
}

/**
 * Structural subset of Electron's `Session` - defined here so the
 * derivation is testable without an Electron runtime. The default
 * session has a non-null but identical `storagePath` across the app
 * (it points at the user-data dir); named partitions have their own
 * subdir, and `in-memory` partitions report `null`.
 */
export interface SessionLike {
  storagePath?: string | null;
}

/**
 * Derive a stable partition identifier from an Electron `Session`.
 *
 * Returns `"default"` when no session is supplied, `"in-memory"` for
 * sessions without on-disk storage, or the `storagePath` verbatim
 * otherwise. The exception store keys on this string, so the only
 * requirement is that it's stable across calls for the same session.
 *
 * Keeps the cert-exception store partition-aware if a future
 * feature introduces named partitions (e.g. per-workspace storage
 * isolation) without needing to plumb anything else through.
 */
export function partitionForSession(session: SessionLike | undefined | null): string {
  if (!session) return "default";
  const path = session.storagePath ?? null;
  if (path === null) return "in-memory";
  return path;
}
