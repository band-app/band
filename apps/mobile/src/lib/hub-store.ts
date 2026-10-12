/**
 * The hubs this phone is paired with. Everything, the token included, lives in the secure
 * store (the iOS Keychain through expo-secure-store, `secure-kv.ts`). Nothing goes to
 * AsyncStorage or a file, and nothing here logs. No React Native imports, so the tests run
 * under Node with an in-memory store.
 */

/** The part of expo-secure-store this module uses. */
export interface SecureKV {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface SavedHub {
  id: string;
  /** The hub's origin. */
  url: string;
  /** The hub's host name, from `/api/health`, or the URL's host. */
  label: string;
  token: string;
}

export interface HubList {
  hubs: SavedHub[];
  activeId: string | null;
}

const INDEX_KEY = "band.hubs";
const hubKey = (id: string) => `band.hub.${id}`;

/** One id per hub origin. Secure store keys allow letters, digits, `.`, `-` and `_`. */
export function hubIdFor(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]/g, "_");
}

interface Index {
  ids: string[];
  activeId: string | null;
}

function parseIndex(raw: string | null): Index {
  if (!raw) return { ids: [], activeId: null };
  try {
    const v = JSON.parse(raw) as Partial<Index>;
    const ids = Array.isArray(v.ids) ? v.ids.filter((x): x is string => typeof x === "string") : [];
    const activeId = typeof v.activeId === "string" && ids.includes(v.activeId) ? v.activeId : null;
    return { ids, activeId };
  } catch {
    return { ids: [], activeId: null };
  }
}

function parseHub(id: string, raw: string | null): SavedHub | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SavedHub>;
    if (typeof v.url !== "string" || typeof v.token !== "string") return null;
    return { id, url: v.url, token: v.token, label: typeof v.label === "string" ? v.label : v.url };
  } catch {
    return null;
  }
}

export class HubStore {
  private readonly kv: SecureKV;

  constructor(kv: SecureKV) {
    this.kv = kv;
  }

  private async index(): Promise<Index> {
    return parseIndex(await this.kv.getItemAsync(INDEX_KEY));
  }

  private writeIndex(index: Index): Promise<void> {
    return this.kv.setItemAsync(INDEX_KEY, JSON.stringify(index));
  }

  /** The saved hubs and the active one. A hub whose entry is unreadable is left out. */
  async list(): Promise<HubList> {
    const index = await this.index();
    const hubs: SavedHub[] = [];
    for (const id of index.ids) {
      const hub = parseHub(id, await this.kv.getItemAsync(hubKey(id)));
      if (hub) hubs.push(hub);
    }
    const activeId = hubs.some((h) => h.id === index.activeId)
      ? index.activeId
      : (hubs[0]?.id ?? null);
    return { hubs, activeId };
  }

  /** Saves a hub (replacing the one with the same URL) and makes it the active one. */
  async save(hub: Omit<SavedHub, "id">): Promise<SavedHub> {
    const saved: SavedHub = { ...hub, id: hubIdFor(hub.url) };
    await this.kv.setItemAsync(
      hubKey(saved.id),
      JSON.stringify({ url: saved.url, label: saved.label, token: saved.token }),
    );
    const index = await this.index();
    const ids = index.ids.includes(saved.id) ? index.ids : [...index.ids, saved.id];
    await this.writeIndex({ ids, activeId: saved.id });
    return saved;
  }

  async setActive(id: string): Promise<void> {
    const index = await this.index();
    if (!index.ids.includes(id)) return;
    await this.writeIndex({ ...index, activeId: id });
  }

  /** Forgets a hub and its token. The next saved hub becomes active when it was the active one. */
  async remove(id: string): Promise<void> {
    await this.kv.deleteItemAsync(hubKey(id));
    const index = await this.index();
    const ids = index.ids.filter((x) => x !== id);
    const activeId = index.activeId === id ? (ids[0] ?? null) : index.activeId;
    await this.writeIndex({ ids, activeId });
  }
}
