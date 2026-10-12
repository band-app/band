/**
 * Client state kept on the Band server, so the phone and the desktop show the
 * same tabs, drafts and panel layout. The store is platform-agnostic: the
 * caller supplies the local storage, the tRPC client and the device type.
 *
 * The local storage is a synchronous read cache: code reads it at mount and
 * writes through the store. A write to a key listed in `client-state-keys.ts`
 * is also pushed to the server, 500 ms after the last change to it. Other
 * devices' writes arrive as `client-state-changed` status events and are
 * written into the local storage.
 *
 * Before the first read, the app hydrates: `hydrate(null)` before the shell
 * mounts and `hydrate(id)` before a worktree's tabs mount. Hydration copies
 * the server's entries into the local storage and uploads local values the
 * server doesn't have yet.
 *
 * Conflicts: every write sends the version it was based on. When another
 * device wrote in between (or this one was offline), the server refuses the
 * write and returns its row, and that row wins here too. Unpushed writes and
 * the last seen versions are kept in the local storage, so a reload while
 * offline pushes them on the next load.
 */

import {
  CLIENT_STATE_MAX_VALUE_BYTES,
  type ClientStateEntry,
  type ClientStateScope,
  type ClientStateWriteResult,
  type DeviceType,
} from "@band-app/shared/client-state";
import { type KeyPart, matchKey } from "@band-app/shared/client-state-keys";

/** Synchronous key-value storage the store reads and writes. the browser's local storage fits on the web. */
export interface ClientStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

/** An asynchronous key-value backend (React Native's AsyncStorage). */
export interface AsyncKeyValueStore {
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Wrap an async backend in the synchronous interface the store needs: `load()`
 * reads every key into memory once, then reads are served from memory and
 * writes go to memory first and to the backend in the background.
 */
export function createCachedStorage(backend: AsyncKeyValueStore): ClientStateStorage & {
  load(): Promise<void>;
} {
  const cache = new Map<string, string>();
  return {
    async load() {
      const keys = await backend.getAllKeys();
      for (const [key, value] of await backend.multiGet(keys)) {
        if (value !== null) cache.set(key, value);
      }
    },
    getItem: (key) => cache.get(key) ?? null,
    setItem(key, value) {
      cache.set(key, value);
      void backend.setItem(key, value).catch(() => {});
    },
    removeItem(key) {
      cache.delete(key);
      void backend.removeItem(key).catch(() => {});
    },
    keys: () => [...cache.keys()],
  };
}

/** The `clientState` tRPC procedures the store calls. */
export interface ClientStateApi {
  clientState: {
    list: {
      query(input: {
        worktreeId: string | null;
        deviceType: DeviceType;
      }): Promise<{ entries: ClientStateEntry[] }>;
    };
    set: {
      mutate(input: {
        key: string;
        scope: ClientStateScope;
        baseVersion: number;
        clientId: string;
        value: unknown;
      }): Promise<ClientStateWriteResult>;
    };
    delete: {
      mutate(input: {
        key: string;
        scope: ClientStateScope;
        baseVersion: number;
        clientId: string;
      }): Promise<ClientStateWriteResult>;
    };
  };
}

export interface ClientStateStoreOptions {
  storage: ClientStateStorage;
  /** Resolves the tRPC client on first use, so importing the store opens no connection. */
  getApi: () => Promise<ClientStateApi>;
  /** Desktop or mobile, fixed for the store's lifetime. Called once. */
  deviceType: () => DeviceType;
  /** Called after the store writes a server value into the storage, for same-page listeners. */
  onStorageWrite?: (key: string, oldValue: string | null, newValue: string | null) => void;
  /** Retry timers and clocks; defaults to the globals. */
  random?: () => number;
}

const META_KEY = "band:client-state:v1";
const PUSH_DELAY_MS = 500;
const MAX_RETRY_MS = 30_000;

export interface ClientStateChange {
  key: string;
  scope: ClientStateScope;
  worktreeId: string | null;
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
  /**
   * Base version of each write sent and not yet answered. A page that closes
   * mid-request never learns whether the write landed; the next load compares
   * the server's version with this to tell its own write from another device's.
   */
  sent: Record<string, number>;
}

function entryId(scope: ClientStateScope, key: string): string {
  return `${scope}|${key}`;
}

function parseEntryId(id: string): { scope: ClientStateScope; key: string } {
  const bar = id.indexOf("|");
  return { scope: id.slice(0, bar) as ClientStateScope, key: id.slice(bar + 1) };
}

function groupOf(worktreeId: string | null): string {
  return worktreeId === null ? "global" : `ws:${worktreeId}`;
}

function byteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** A network failure is worth retrying; a server error answer (4xx/5xx) is not. */
function isNetworkError(err: unknown): boolean {
  const data = (err as { data?: { httpStatus?: number } } | null)?.data;
  return !data?.httpStatus;
}

export class ClientStateStore {
  readonly clientId: string;
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

  private readonly options: ClientStateStoreOptions;

  constructor(options: ClientStateStoreOptions) {
    this.options = options;
    this.clientId =
      (options.random ?? Math.random)().toString(36).slice(2) + Date.now().toString(36);
  }

  private readLocal(key: string): string | null {
    try {
      return this.options.storage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeLocal(key: string, raw: string | null): void {
    try {
      if (raw === null) this.options.storage.removeItem(key);
      else this.options.storage.setItem(key, raw);
    } catch {}
  }

  private localKeys(): string[] {
    try {
      return this.options.storage.keys();
    } catch {
      return [];
    }
  }

  /** Desktop or mobile, fixed for the store's lifetime. */
  deviceType(): DeviceType {
    if (!this.device) this.device = this.options.deviceType();
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
    let meta: Meta = { versions: {}, pending: [], sent: {} };
    try {
      const raw = this.readLocal(META_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Meta>;
        meta = {
          versions: parsed.versions && typeof parsed.versions === "object" ? parsed.versions : {},
          pending: Array.isArray(parsed.pending) ? parsed.pending : [],
          sent: parsed.sent && typeof parsed.sent === "object" ? parsed.sent : {},
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
      this.writeLocal(META_KEY, JSON.stringify(this.getMeta()));
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
    return this.readLocal(key);
  }

  setItem(key: string, raw: string): void {
    this.writeLocal(key, raw);
    this.changed(key);
  }

  removeItem(key: string): void {
    this.writeLocal(key, null);
    this.changed(key);
  }

  private changed(key: string): void {
    const matched = matchKey(key);
    if (!matched) return;
    for (const part of matched.parts) {
      const id = entryId(this.resolveScope(part), key);
      this.setPending(id, true);
      if (this.inflight.has(id)) this.dirtyAgain.add(id);
      if (this.hydrated.has(groupOf(matched.worktreeId))) this.schedule(id);
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
    let value = part.pick(this.readLocal(key));
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
    this.getMeta().sent[id] = baseVersion;
    this.saveMeta();
    let result: ClientStateWriteResult;
    try {
      const common = { key, scope, baseVersion, clientId: this.clientId };
      const trpc = await this.options.getApi();
      // tRPC types a `z.unknown()` field as optional; the server always sets it.
      result = (
        value == null
          ? await trpc.clientState.delete.mutate(common)
          : await trpc.clientState.set.mutate({ ...common, value })
      ) as ClientStateWriteResult;
    } catch (err) {
      this.inflight.delete(id);
      this.dirtyAgain.delete(id);
      // The request may have reached the server; keep `sent` for the next load.
      if (isNetworkError(err)) {
        this.scheduleRetry();
      } else {
        console.warn("[client-state] server refused write for", key, err);
        delete this.getMeta().sent[id];
        this.setPending(id, false);
      }
      return;
    }
    this.inflight.delete(id);
    delete this.getMeta().sent[id];
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
      if (matched && this.hydrated.has(groupOf(matched.worktreeId))) this.schedule(id, 0);
    }
  }

  // ---- server values ----

  /** Take a server entry: record it and write it into local storage. */
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

    const oldRaw = this.readLocal(entry.key);
    const newRaw = part.merge(oldRaw, entry.value);
    // Nothing to tell anyone when this device already had the value (a
    // re-read after a reconnect, or a change to another part of the key).
    if (newRaw === oldRaw) return;
    this.writeLocal(entry.key, newRaw);
    try {
      this.options.onStorageWrite?.(entry.key, oldRaw, newRaw);
    } catch {}
    const change: ClientStateChange = {
      key: entry.key,
      scope: entry.scope,
      worktreeId: entry.worktreeId,
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
    if (!this.hydrated.has(groupOf(matched.worktreeId))) return;
    const id = entryId(entry.scope, entry.key);
    if ((this.getMeta().versions[id] ?? 0) >= entry.version) return;
    this.apply(entry, "remote");
  }

  hydrate(worktreeId: string | null, force = false): Promise<void> {
    const group = groupOf(worktreeId);
    if (!force && this.hydrated.has(group)) return Promise.resolve();
    const running = this.hydrating.get(group);
    if (running) return running;
    const promise = this.load(worktreeId)
      .catch((err) => {
        // Offline: keep using local storage and try again on reconnect.
        console.warn("[client-state] hydrate failed:", err);
      })
      .finally(() => this.hydrating.delete(group));
    this.hydrating.set(group, promise);
    return promise;
  }

  private async load(worktreeId: string | null): Promise<void> {
    const group = groupOf(worktreeId);
    const trpc = await this.options.getApi();
    const { entries } = (await trpc.clientState.list.query({
      worktreeId,
      deviceType: this.deviceType(),
    })) as { entries: ClientStateEntry[] };
    const meta = this.getMeta();
    const onServer = new Set<string>();
    for (const entry of entries) {
      const id = entryId(entry.scope, entry.key);
      onServer.add(id);
      const pending = meta.pending.includes(id);
      // A write this device sent just before the page closed landed on the
      // server, and the local value is newer than it.
      const sentBase = meta.sent[id];
      const ownWrite = sentBase !== undefined && entry.version === sentBase + 1;
      delete meta.sent[id];
      if (pending && (ownWrite || (meta.versions[id] ?? 0) === entry.version)) {
        // Changed offline, and no other device wrote since: push it.
        this.confirmed.set(id, entry.value);
        meta.versions[id] = entry.version;
        continue;
      }
      this.apply(entry, "hydrate");
    }

    // Local values the server has never seen: first load after this change
    // shipped, or keys written while the worktree had no server rows.
    for (const key of this.localKeys()) {
      const matched = matchKey(key);
      if (!matched || groupOf(matched.worktreeId) !== group) continue;
      for (const part of matched.parts) {
        const id = entryId(this.resolveScope(part), key);
        if (onServer.has(id)) continue;
        this.confirmed.delete(id);
        meta.versions[id] = 0;
        if (part.pick(this.readLocal(key)) != null && !meta.pending.includes(id))
          meta.pending.push(id);
      }
    }
    // A sent write the server doesn't have never landed.
    for (const id of Object.keys(meta.sent)) {
      const matched = matchKey(parseEntryId(id).key);
      if (matched && groupOf(matched.worktreeId) === group && !onServer.has(id)) {
        delete meta.sent[id];
      }
    }
    // Pending entries whose key is gone locally and unknown to the server.
    for (const id of meta.pending) {
      const matched = matchKey(parseEntryId(id).key);
      if (matched && groupOf(matched.worktreeId) === group && !onServer.has(id)) {
        meta.versions[id] = 0;
      }
    }
    this.saveMeta();
    this.hydrated.add(group);
    this.flushPending();
  }

  /** A worktree was deleted: its server rows are gone, drop the local copies. */
  forgetWorktree(worktreeId: string): void {
    const group = groupOf(worktreeId);
    const meta = this.getMeta();
    for (const key of this.localKeys()) {
      const matched = matchKey(key);
      if (!matched || groupOf(matched.worktreeId) !== group) continue;
      this.writeLocal(key, null);
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
      return !matched || groupOf(matched.worktreeId) !== group;
    });
    for (const id of Object.keys(meta.sent)) {
      const matched = matchKey(parseEntryId(id).key);
      if (matched && groupOf(matched.worktreeId) === group) delete meta.sent[id];
    }
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

  /**
   * Follow other devices' writes on the status stream, re-read after a
   * reconnect, and drop a deleted worktree's keys.
   */
  startSync(
    subscribeStatusEvents: (handler: (event: Record<string, unknown>) => void) => () => void,
  ): void {
    let snapshots = 0;
    subscribeStatusEvents((event) => {
      if (event.kind === "client-state-changed" && event.clientState) {
        this.receive(event.clientState as ClientStateEntry, event.clientId as string | undefined);
      } else if (event.kind === "remove" && typeof event.worktreeId === "string") {
        this.forgetWorktree(event.worktreeId);
      } else if (event.kind === "snapshot") {
        // The server sends a snapshot on every (re)subscribe. The first is the
        // initial connect; later ones mean we were disconnected.
        snapshots += 1;
        if (snapshots > 1) this.resync();
      }
    });
  }
}
