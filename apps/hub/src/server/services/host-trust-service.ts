/**
 * Per-host trust levels (`restricted`, `standard`, `admin`) and the audit log of what admin hosts
 * do across hosts. The relay (`worker-relay-service.ts`) reads the level on every call, never
 * caching it, so lowering a host takes effect on the next call.
 */

import { defaultHostTrust, type HostTrust, isHostTrust } from "@band-app/shared/host-trust";
import { HostAuditQueries, type HostAuditRow } from "../infra/db/queries/host-audit";
import { TokenQueries } from "../infra/db/queries/tokens";

/** One entry of the audit log, as `recordAudit` takes it. */
export interface AuditEntry {
  callerHostId: string;
  chatId?: string | null;
  procedure: string;
  targetHostId?: string | null;
  target?: string | null;
}

const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export class HostTrustService {
  private readonly hosts = new TokenQueries();
  private readonly audit = new HostAuditQueries();

  /**
   * A host's effective level: the one an admin set, else `restricted` for an ephemeral host and
   * `standard` for the rest. An unknown host is `restricted`, so a stale link gets the least.
   */
  trustOf(hostId: string): HostTrust {
    const host = this.hosts.findHost(hostId);
    if (!host) return "restricted";
    // A stored value this build does not know gets the least, not the default.
    if (host.trust) return isHostTrust(host.trust) ? host.trust : "restricted";
    return defaultHostTrust({
      ephemeral: host.mode === "ephemeral" || host.info?.mode === "ephemeral",
    });
  }

  /** Stores a level. Returns false for an unknown host. */
  setTrust(hostId: string, trust: HostTrust): boolean {
    return this.hosts.setHostTrust(hostId, trust);
  }

  recordAudit(entry: AuditEntry, at: number = Date.now()): void {
    this.audit.insert({
      at,
      callerHostId: entry.callerHostId,
      chatId: entry.chatId ?? null,
      procedure: entry.procedure,
      targetHostId: entry.targetHostId ?? null,
      target: entry.target ?? null,
    });
    // Old entries go out with new ones, so the log needs no sweep of its own.
    this.audit.prune(at - KEEP_MS);
  }

  listAudit(limit: number): HostAuditRow[] {
    return this.audit.list(limit);
  }
}

export const hostTrustService = new HostTrustService();
