/**
 * Runs the worker services of installed extensions on workers (`docs/extensions.md`). The hub
 * tells each eligible worker which extensions to run (`extensions.sync`) and serves their
 * archives (`extensions.fetch`). A worker is eligible when its trust level is `standard` or
 * `admin` and it is a connected worker, never the hub's own machine. The worker checks each
 * service's `requires` and reports why one does not start.
 */

import type { HostExtensionItem, HostExtensionServiceState } from "@band-app/host-api";
import {
  type ExtensionsFetchParams,
  type ExtensionsFetchReply,
  METHOD_EXTENSIONS_CHANGED,
  METHOD_EXTENSIONS_FETCH,
  RPC_METHOD_NOT_FOUND,
  RpcError,
  type ServerSession,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { hostRegistry } from "../infra/host/registry";
import { extensionService } from "./extension-service";
import { hostTrustService } from "./host-trust-service";
import { emit } from "./watcher-service";

const log = createLogger("extension-workers");

const RPC_INVALID_PARAMS = -32602;
const RPC_FORBIDDEN = -32003;

/** One service of an extension on a worker, as `workers.list` shows it. */
export interface ExtensionServiceView {
  extensionId: string;
  serviceId: string;
  capability: string;
  version: string;
  state: HostExtensionServiceState["state"];
  reason?: string;
}

interface Cached {
  services: HostExtensionServiceState[];
  problems: Array<{ extensionId: string; reason: string }>;
}

export class ExtensionWorkerService {
  /** The last states each worker reported. */
  private readonly states = new Map<string, Cached>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor() {
    extensionService.onChange(() => void this.syncAll());
  }

  /** Answers the worker's archive downloads and notices of changed states. */
  attach(session: ServerSession): void {
    const workerId = session.workerId;
    session.handle(METHOD_EXTENSIONS_FETCH, async (params) => {
      if (hostTrustService.trustOf(workerId) === "restricted") {
        throw new RpcError(RPC_FORBIDDEN, "a restricted worker runs no extension services");
      }
      const p = params as Partial<ExtensionsFetchParams> | null;
      if (typeof p?.id !== "string" || typeof p.version !== "string") {
        throw new RpcError(RPC_INVALID_PARAMS, "id and version are required");
      }
      const found = await extensionService.readArchive(p.id, p.version);
      if (!found) throw new RpcError(RPC_INVALID_PARAMS, `no archive of ${p.id} ${p.version}`);
      // The channel is open before the reply, so the worker finds it.
      const ch = session.openChannel("payload");
      ch.discardIncoming();
      ch.send(found.bytes).then(
        () => ch.end(),
        () => undefined,
      );
      const reply: ExtensionsFetchReply = {
        sha256: found.archive.sha256,
        size: found.bytes.length,
        chan: ch.id,
      };
      return reply;
    });
    session.onNotification(METHOD_EXTENSIONS_CHANGED, () => void this.refresh(workerId));
  }

  /** The extensions a worker should run now: none for a restricted worker. */
  async desiredFor(hostId: string): Promise<HostExtensionItem[]> {
    if (hostTrustService.trustOf(hostId) === "restricted") return [];
    const items: HostExtensionItem[] = [];
    for (const manifest of (await extensionService.list()).extensions) {
      if (manifest.contributes.workerServices.length === 0) continue;
      const archive = await extensionService.archiveOf(manifest.id);
      if (!archive || archive.version !== manifest.version) continue;
      items.push({ id: manifest.id, version: archive.version, sha256: archive.sha256 });
    }
    return items;
  }

  /** Makes a worker's running set match what it should run. Calls for one worker run in order. */
  syncHost(hostId: string): Promise<void> {
    const run = (this.chains.get(hostId) ?? Promise.resolve()).then(() => this.doSync(hostId));
    this.chains.set(
      hostId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async doSync(hostId: string): Promise<void> {
    if (hostId === "local") return;
    let host: ReturnType<typeof hostRegistry.hostById>;
    try {
      host = hostRegistry.hostById(hostId);
    } catch {
      return;
    }
    if (!host.extensions) return;
    try {
      const items = await this.desiredFor(hostId);
      const reply = await host.extensions.sync(items);
      this.states.set(hostId, reply);
      emit({ kind: "host-status-changed", hostId });
    } catch (err) {
      // An older worker has no such method, and an offline one syncs when it connects.
      if (err instanceof RpcError && err.code === RPC_METHOD_NOT_FOUND) return;
      log.warn(`extension sync on ${hostId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Asks a worker for its states without changing anything. */
  async refresh(hostId: string): Promise<void> {
    try {
      const host = hostRegistry.hostById(hostId);
      if (!host.extensions) return;
      this.states.set(hostId, await host.extensions.status());
      emit({ kind: "host-status-changed", hostId });
    } catch (err) {
      log.debug(`extension status on ${hostId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Every connected worker. For an install, update or removal. */
  async syncAll(): Promise<void> {
    for (const id of this.connectedIds()) await this.syncHost(id).catch(() => undefined);
  }

  private connectedIds: () => string[] = () => [];

  /** Lets the link service say which workers are connected. */
  useConnected(fn: () => string[]): void {
    this.connectedIds = fn;
  }

  onConnected(hostId: string): void {
    void this.syncHost(hostId);
  }

  forget(hostId: string): void {
    this.states.delete(hostId);
  }

  /**
   * What `workers.list` shows for a worker. A restricted worker lists each worker-service
   * extension as not eligible. For others it is what the worker last reported.
   */
  async viewFor(hostId: string, online: boolean): Promise<ExtensionServiceView[]> {
    const manifests = (await extensionService.list()).extensions.filter(
      (m) => m.contributes.workerServices.length > 0,
    );
    if (manifests.length === 0) return [];
    const reason =
      hostId === "local"
        ? "the hub's own machine runs no extension services"
        : hostTrustService.trustOf(hostId) === "restricted"
          ? "restricted"
          : null;
    if (reason !== null) {
      return manifests.flatMap((m) =>
        m.contributes.workerServices.map((s) => ({
          extensionId: m.id,
          serviceId: s.id,
          capability: s.capability,
          version: m.version,
          state: "not-eligible" as const,
          reason,
        })),
      );
    }
    if (!online) return [];
    const cached = this.states.get(hostId);
    const out: ExtensionServiceView[] = [...(cached?.services ?? [])];
    for (const p of cached?.problems ?? []) {
      const m = manifests.find((x) => x.id === p.extensionId);
      for (const s of m?.contributes.workerServices ?? []) {
        out.push({
          extensionId: p.extensionId,
          serviceId: s.id,
          capability: s.capability,
          version: m?.version ?? "",
          state: "failed",
          reason: p.reason,
        });
      }
    }
    return out;
  }
}

export const extensionWorkerService = new ExtensionWorkerService();
