import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { checkHub, type HubCheck } from "./hub-api";
import type { HubList, SavedHub } from "./hub-store";
import { exchangePairingCode, type PairingInput } from "./pairing";
import { hubStore } from "./secure-kv";

export type Connection =
  | { state: "checking" }
  | { state: "connected" }
  | { state: "unreachable"; reason: string; invalidToken: boolean };

interface HubsValue {
  /** Null until the secure store has been read. */
  list: HubList | null;
  /** Why reading the secure store failed, if it did. */
  loadError: string | null;
  active: SavedHub | null;
  connection: Connection;
  /** Checks the URL and token with the hub, and saves the hub only when both work. */
  pair: (pairing: PairingInput) => Promise<HubCheck>;
  /** Checks the active hub again. */
  recheck: () => Promise<Connection>;
  setActive: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const HubsContext = createContext<HubsValue | null>(null);

function toConnection(check: HubCheck): Connection {
  if (check.ok) return { state: "connected" };
  return {
    state: "unreachable",
    reason: check.error,
    invalidToken: check.reason === "invalid-token",
  };
}

export function HubsProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<HubList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>({ state: "checking" });

  // The last list read, for callbacks that must compare against the current active hub rather
  // than the one from the render that created them.
  const listRef = useRef<HubList | null>(null);

  const reload = useCallback(async () => {
    const next = await hubStore.list();
    listRef.current = next;
    setList(next);
    return next;
  }, []);

  useEffect(() => {
    reload().catch((err: unknown) => {
      setLoadError(err instanceof Error ? err.message : String(err));
    });
  }, [reload]);

  // Every reload parses new objects, so keep the same `active` object while the saved hub is
  // unchanged. Home re-checks the hub whenever `active` changes.
  const found = list?.hubs.find((h) => h.id === list.activeId) ?? null;
  const activeRef = useRef<SavedHub | null>(null);
  const prev = activeRef.current;
  const active =
    found &&
    prev &&
    found.id === prev.id &&
    found.url === prev.url &&
    found.token === prev.token &&
    found.label === prev.label
      ? prev
      : found;
  activeRef.current = active;

  // Each check gets a number, and only the newest one may set `connection`, so a slow check of
  // a hub the user has switched away from can't overwrite the state of the hub now shown.
  const checkSeq = useRef(0);

  const recheck = useCallback(async (): Promise<Connection> => {
    if (!active) return { state: "checking" };
    const seq = ++checkSeq.current;
    setConnection({ state: "checking" });
    const next = toConnection(await checkHub(active.url, active.token));
    if (seq === checkSeq.current) setConnection(next);
    return next;
  }, [active]);

  const pair = useCallback(
    async (input: PairingInput): Promise<HubCheck> => {
      // A code is spent by the exchange, so nothing is saved before it succeeds.
      const exchanged = await exchangePairingCode(input);
      if (!exchanged.ok) return { ok: false, reason: "error", error: exchanged.error };
      const pairing = exchanged.value;
      const check = await checkHub(pairing.url, pairing.token);
      // The code is spent once the exchange answers, so a failure from here on needs a new link.
      const spent =
        "code" in input ? " The link was used. Create a new one in Settings > Devices." : "";
      if (!check.ok) return { ...check, error: `${check.error}${spent}` };
      try {
        await hubStore.save({ url: pairing.url, token: pairing.token, label: check.label });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: "error", error: `Could not save the hub: ${message}${spent}` };
      }
      checkSeq.current++;
      setConnection({ state: "connected" });
      // The hub is saved and active; a failed read only leaves the list stale until the next one.
      await reload().catch(() => {});
      return check;
    },
    [reload],
  );

  /** Forgets the active hub's connection state when another hub becomes the active one. */
  const activeChanging = useCallback(() => {
    checkSeq.current++;
    setConnection({ state: "checking" });
  }, []);

  const setActive = useCallback(
    async (id: string) => {
      await hubStore.setActive(id);
      if (id !== listRef.current?.activeId) activeChanging();
      await reload();
    },
    [reload, activeChanging],
  );

  const remove = useCallback(
    async (id: string) => {
      await hubStore.remove(id);
      if (id === listRef.current?.activeId) activeChanging();
      await reload();
    },
    [reload, activeChanging],
  );

  const value = useMemo(
    () => ({ list, loadError, active, connection, pair, recheck, setActive, remove }),
    [list, loadError, active, connection, pair, recheck, setActive, remove],
  );
  return <HubsContext.Provider value={value}>{children}</HubsContext.Provider>;
}

export function useHubs(): HubsValue {
  const value = useContext(HubsContext);
  if (!value) throw new Error("useHubs needs a HubsProvider");
  return value;
}
