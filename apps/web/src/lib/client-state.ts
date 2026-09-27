/**
 * Client state kept on the Band server, so the phone and the desktop show the
 * same tabs, drafts and panel layout.
 *
 * localStorage stays the synchronous read cache: code keeps reading
 * `localStorage` (or `clientStorage.getItem`) at mount, and writes through
 * `clientStorage.setItem` / `removeItem`. A write to a key listed in
 * `client-state-keys.ts` is also pushed to the server, 500 ms after the last
 * change to it. Other devices' writes arrive as `client-state-changed` status
 * events and are written into localStorage, with a `storage` event so the
 * existing cross-window listeners pick them up.
 *
 * Before the first read, the dashboard hydrates: `hydrateGlobal()` before the
 * app shell mounts and `hydrateWorkspace(id)` before a workspace's dockview
 * mounts. Hydration copies the server's entries into localStorage and uploads
 * local values the server doesn't have yet, which moves existing
 * localStorage state to the server on first load.
 *
 * Conflicts: every write sends the version it was based on. When another
 * device wrote in between (or this one was offline), the server refuses the
 * write and returns its row, and that row wins here too. Unpushed writes and
 * the last seen versions are kept in localStorage, so a reload while offline
 * pushes them on the next load.
 */

import { DESKTOP_QUERY } from "../hooks/useIsDesktop";
import {
  CLIENT_STATE_MAX_VALUE_BYTES,
  type ClientStateEntry,
  type ClientStateScope,
  type ClientStateWriteResult,
  type DeviceType,
} from "../shared/client-state";
import { type KeyPart, matchKey } from "../shared/client-state-keys";
import { isDesktop } from "./is-desktop";

/**
 * Loaded on first use: importing the tRPC client opens its WebSocket, and
 * modules like `zoom.ts` that write through `clientStorage` are also
 * imported by jsdom unit tests with no server.
 */
async function api() {
  return (await import("./trpc-client")).trpc;
}

const META_KEY = "band:client-state:v1";
const PUSH_DELAY_MS = 500;
const MAX_RETRY_MS = 30_000;
/** How long a mount waits for hydration before it reads localStorage as it is. */
export const HYDRATE_WAIT_MS = 1500;

export interface ClientStateChange {
  key: string;
  scope: ClientStateScope;
  workspaceId: string | null;
  value: unknown;
  /** The previous server value this device knew, before this change. */
  previous: unknown;
  /** `remote`: another device wrote it. `conflict`: this device's write was refused. */
  source: "remote" | "conflict" | "hydrate";
}

interface Meta {
  /** Last server version seen, by entry id (`<scope>|<key>`). */
  versions: Record<string, number>;
  /** Entry ids with a local change not yet on the server. */
  pending: string[];
}

function entryId(scope: ClientStateScope, key: string): string {
  return `${scope}|${key}`;
}

function parseEntryId(id: string): { scope: ClientStateScope; key: string } {
  const bar = id.indexOf("|");
  return { scope: id.slice(0, bar) as ClientStateScope, key: id.slice(bar + 1) };
}

function groupOf(workspaceId: string | null): string {
  return workspaceId === null ? "global" : `ws:${workspaceId}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, raw: string | null): void {
  try {
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
  } catch {}
}

function localKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
  } catch {}
  return keys;
}

/** A network failure is worth retrying; a server error answer (4xx/5xx) is not. */
function isNetworkError(err: unknown): boolean {
  const data = (err as { data?: { httpStatus?: number } } | null)?.data;
  return !data?.httpStatus;
}

class ClientStateStore {
  readonly clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private device: DeviceType | null = null;
  private meta: Meta | null = null;
  private metaSaveQueued = false;
  /** Last server value per entry id, as seen by this page. */
  private readonly confirmed = new Map<string, unknown>();
  private readonly hydrated = new Set<string>();
  private readonly hydrating = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Set<string>();
  /** Entries changed again while their push was in flight. */
  private readonly dirtyAgain = new Set<string>();
  private retryDelay = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(change: ClientStateChange) => void>();

  /** Desktop or mobile, fixed for the page's lifetime (same breakpoint as the layout). */
  deviceType(): DeviceType {
    if (!this.device) {
      const wide = typeof window !== "undefined" && window.matchMedia?.(DESKTOP_QUERY)?.matches;
      this.device = isDesktop || wide ? "desktop" : "mobile";
    }
    return this.device;
  }

  private resolveScope(part: KeyPart): ClientStateScope {
    return part.scope === "all" ? "all" : this.deviceType();
  }

  private partFor(key: string, scope: ClientStateScope): KeyPart | undefined {
    return matchKey(key)?.parts.find((p) => this.resolveScope(p) === scope);
  }

  private getMeta(): Meta {
    if (this.meta) return this.meta;
    let meta: Meta = { versions: {}, pending: [] };
    try {
      const raw = localStorage.getItem(META_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Meta>;
        meta = {
          versions: parsed.versions && typeof parsed.versions === "object" ? parsed.versions : {},
          pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        };
      }
    } catch {}
    this.meta = meta;
    return meta;
  }

  /** Write the meta blob once per task, however many entries changed in it. */
  private saveMeta(): void {
    if (this.metaSaveQueued) return;
    this.metaSaveQueued = true;
    queueMicrotask(() => {
      this.metaSaveQueued = false;
      writeLocal(META_KEY, JSON.stringify(this.getMeta()));
    });
  }

  private setPending(id: string, pending: boolean): void {
    const meta = this.getMeta();
    const has = meta.pending.includes(id);
    if (pending && !has) meta.pending.push(id);
    else if (!pending && has) meta.pending = meta.pending.filter((p) => p !== id);
    else return;
    this.saveMeta();
  }

  private setVersion(id: string, version: number): void {
    this.getMeta().versions[id] = version;
    this.saveMeta();
  }

  // ---- local writes ----

  getItem(key: string): string | null {
    return readLocal(key);
  }

  setItem(key: string, raw: string): void {
    writeLocal(key, raw);
    this.changed(key);
  }

  removeItem(key: string): void {
    writeLocal(key, null);
    this.changed(key);
  }

  private changed(key: string): void {
    const matched = matchKey(key);
    if (!matched) return;
    for (const part of matched.parts) {
      const id = entryId(this.resolveScope(part), key);
      this.setPending(id, true);
      if (this.inflight.has(id)) this.dirtyAgain.add(id);
      if (this.hydrated.has(groupOf(matched.workspaceId))) this.schedule(id);
    }
  }

  private schedule(id: string, delay = PUSH_DELAY_MS): void {
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.push(id);
      }, delay),
    );
  }

  private async push(id: string): Promise<void> {
    if (this.inflight.has(id)) {
      this.dirtyAgain.add(id);
      return;
    }
    const { scope, key } = parseEntryId(id);
    const matched = matchKey(key);
    const part = this.partFor(key, scope);
    if (!matched || !part) {
      this.setPending(id, false);
      return;
    }
    let value = part.pick(readLocal(key));
    // Too large for the server (a big file's unsaved text): keep it on this
    // device and clear the server copy, so no device loads a stale one.
    if (value != null && byteLength(JSON.stringify(value)) > CLIENT_STATE_MAX_VALUE_BYTES) {
      value = null;
    }
    const baseVersion = this.getMeta().versions[id] ?? 0;
    const known = this.confirmed.has(id) || baseVersion > 0;
    if ((known && sameValue(value, this.confirmed.get(id))) || (!known && value == null)) {
      this.setPending(id, false);
      return;
    }

    this.inflight.add(id);
    let result: ClientStateWriteResult;
    try {
      const common = { key, scope, baseVersion, clientId: this.clientId };
      const trpc = await api();
      // tRPC types a `z.unknown()` field as optional; the server always sets it.
      result = (
        value == null
          ? await trpc.clientState.delete.mutate(common)
          : await trpc.clientState.set.mutate({ ...common, value })
      ) as ClientStateWriteResult;
    } catch (err) {
      this.inflight.delete(id);
      this.dirtyAgain.delete(id);
      if (isNetworkError(err)) {
        this.scheduleRetry();
      } else {
        console.warn("[client-state] server refused write for", key, err);
        this.setPending(id, false);
      }
      return;
    }
    this.inflight.delete(id);
    this.retryDelay = 0;

    if (result.ok) {
      this.confirmed.set(id, result.entry.value);
      this.setVersion(id, result.entry.version);
      if (this.dirtyAgain.delete(id)) this.schedule(id);
      else this.setPending(id, false);
    } else {
      // Another device wrote first: its value wins.
      this.dirtyAgain.delete(id);
      this.apply(result.entry, "conflict");
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryDelay = Math.min(this.retryDelay ? this.retryDelay * 2 : 2000, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flushPending();
    }, this.retryDelay);
  }

  /** Push every pending entry whose group is hydrated. */
  flushPending(): void {
    for (const id of this.getMeta().pending) {
      const matched = matchKey(parseEntryId(id).key);
      if (matched && this.hydrated.has(groupOf(matched.workspaceId))) this.schedule(id, 0);
    }
  }

  // ---- server values ----

  /** Take a server entry: record it and write it into localStorage. */
  private apply(entry: ClientStateEntry, source: ClientStateChange["source"]): void {
    const id = entryId(entry.scope, entry.key);
    const part = this.partFor(entry.key, entry.scope);
    if (!part) return;
    const previous = this.confirmed.get(id) ?? null;
    this.confirmed.set(id, entry.value);
    this.setVersion(id, entry.version);
    this.setPending(id, false);
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    const oldRaw = readLocal(entry.key);
    const newRaw = part.merge(oldRaw, entry.value);
    // Nothing to tell anyone when this device already had the value (a
    // re-read after a reconnect, or a change to another part of the key).
    if (newRaw === oldRaw) return;
    writeLocal(entry.key, newRaw);
    try {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: entry.key,
          oldValue: oldRaw,
          newValue: newRaw,
          storageArea: localStorage,
          url: location.href,
        }),
      );
    } catch {}
    const change: ClientStateChange = {
      key: entry.key,
      scope: entry.scope,
      workspaceId: entry.workspaceId,
      value: entry.value,
      previous,
      source,
    };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        console.error("[client-state] listener failed:", err);
      }
    }
  }

  /** A `client-state-changed` event from another device (or a stale echo). */
  receive(entry: ClientStateEntry, clientId: string | undefined): void {
    if (clientId === this.clientId) return;
    const matched = matchKey(entry.key);
    if (!matched || !this.partFor(entry.key, entry.scope)) return;
    // Only hydrated groups track versions; the rest pick it up on hydrate.
    if (!this.hydrated.has(groupOf(matched.workspaceId))) return;
    const id = entryId(entry.scope, entry.key);
    if ((this.getMeta().versions[id] ?? 0) >= entry.version) return;
    this.apply(entry, "remote");
  }

  hydrate(workspaceId: string | null, force = false): Promise<void> {
    const group = groupOf(workspaceId);
    if (!force && this.hydrated.has(group)) return Promise.resolve();
    const running = this.hydrating.get(group);
    if (running) return running;
    const promise = this.load(workspaceId)
      .catch((err) => {
        // Offline: keep using localStorage and try again on reconnect.
        console.warn("[client-state] hydrate failed:", err);
      })
      .finally(() => this.hydrating.delete(group));
    this.hydrating.set(group, promise);
    return promise;
  }

  private async load(workspaceId: string | null): Promise<void> {
    const group = groupOf(workspaceId);
    const trpc = await api();
    const { entries } = (await trpc.clientState.list.query({
      workspaceId,
      deviceType: this.deviceType(),
    })) as { entries: ClientStateEntry[] };
    const meta = this.getMeta();
    const onServer = new Set<string>();
    for (const entry of entries) {
      const id = entryId(entry.scope, entry.key);
      onServer.add(id);
      const pending = meta.pending.includes(id);
      if (pending && (meta.versions[id] ?? 0) === entry.version) {
        // Changed offline, and no other device wrote since: push it.
        this.confirmed.set(id, entry.value);
        continue;
      }
      this.apply(entry, "hydrate");
    }

    // Local values the server has never seen: first load after this change
    // shipped, or keys written while the workspace had no server rows.
    for (const key of localKeys()) {
      const matched = matchKey(key);
      if (!matched || groupOf(matched.workspaceId) !== group) continue;
      for (const part of matched.parts) {
        const id = entryId(this.resolveScope(part), key);
        if (onServer.has(id)) continue;
        this.confirmed.delete(id);
        meta.versions[id] = 0;
        if (part.pick(readLocal(key)) != null && !meta.pending.includes(id)) meta.pending.push(id);
      }
    }
    // Pending entries whose key is gone locally and unknown to the server.
    for (const id of meta.pending) {
      const matched = matchKey(parseEntryId(id).key);
      if (matched && groupOf(matched.workspaceId) === group && !onServer.has(id)) {
        meta.versions[id] = 0;
      }
    }
    this.saveMeta();
    this.hydrated.add(group);
    this.flushPending();
  }

  /** A workspace was deleted: its server rows are gone, drop the local copies. */
  forgetWorkspace(workspaceId: string): void {
    const group = groupOf(workspaceId);
    const meta = this.getMeta();
    for (const key of localKeys()) {
      const matched = matchKey(key);
      if (!matched || groupOf(matched.workspaceId) !== group) continue;
      writeLocal(key, null);
      for (const part of matched.parts) {
        const id = entryId(this.resolveScope(part), key);
        this.confirmed.delete(id);
        delete meta.versions[id];
        const timer = this.timers.get(id);
        if (timer) clearTimeout(timer);
        this.timers.delete(id);
      }
    }
    meta.pending = meta.pending.filter((id) => {
      const matched = matchKey(parseEntryId(id).key);
      return !matched || groupOf(matched.workspaceId) !== group;
    });
    this.saveMeta();
    this.hydrated.delete(group);
  }

  /** The status stream reconnected: re-read what may have changed meanwhile. */
  resync(): void {
    for (const group of [...this.hydrated]) {
      void this.hydrate(group === "global" ? null : group.slice(3), true);
    }
  }

  subscribe(listener: (change: ClientStateChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const store = new ClientStateStore();

/** localStorage with server sync for the keys in `client-state-keys.ts`. */
export const clientStorage = {
  getItem: (key: string): string | null => store.getItem(key),
  setItem: (key: string, value: string): void => store.setItem(key, value),
  removeItem: (key: string): void => store.removeItem(key),
};

/** Resolve once the global keys are hydrated, or after `timeoutMs` (offline). */
export function hydrateGlobal(timeoutMs = HYDRATE_WAIT_MS): Promise<void> {
  return withTimeout(store.hydrate(null), timeoutMs);
}

/** Resolve once a workspace's keys are hydrated, or after `timeoutMs` (offline). */
export function hydrateWorkspace(workspaceId: string, timeoutMs = HYDRATE_WAIT_MS): Promise<void> {
  return withTimeout(store.hydrate(workspaceId), timeoutMs);
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Changes that came from the server (another device, a refused write, hydration). */
export function subscribeClientState(listener: (change: ClientStateChange) => void): () => void {
  return store.subscribe(listener);
}

let syncStarted = false;

/**
 * Follow other devices' writes on the status stream, re-read after a
 * reconnect, and drop a deleted workspace's keys. Idempotent.
 */
export function startClientStateSync(
  subscribeStatusEvents: (handler: (event: Record<string, unknown>) => void) => () => void,
): void {
  if (syncStarted || typeof window === "undefined") return;
  syncStarted = true;
  let snapshots = 0;
  subscribeStatusEvents((event) => {
    if (event.kind === "client-state-changed" && event.clientState) {
      store.receive(event.clientState as ClientStateEntry, event.clientId as string | undefined);
    } else if (event.kind === "remove" && typeof event.workspaceId === "string") {
      store.forgetWorkspace(event.workspaceId);
    } else if (event.kind === "snapshot") {
      // The server sends a snapshot on every (re)subscribe. The first is the
      // initial connect; later ones mean we were disconnected.
      snapshots += 1;
      if (snapshots > 1) store.resync();
    }
  });
  // Writes still pending when the page closes stay in the meta blob and are
  // pushed on the next load.
  window.addEventListener("online", () => store.flushPending());
}
