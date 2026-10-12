import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { checkHub, type HubCheck } from "./hub-api";
import type { HubList, SavedHub } from "./hub-store";
import type { Pairing } from "./pairing";
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
  pair: (pairing: Pairing) => Promise<HubCheck>;
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

  const reload = useCallback(async () => {
    const next = await hubStore.list();
    setList(next);
    return next;
  }, []);

  useEffect(() => {
    reload().catch((err: unknown) => {
      setLoadError(err instanceof Error ? err.message : String(err));
    });
  }, [reload]);

  const active = useMemo(() => list?.hubs.find((h) => h.id === list.activeId) ?? null, [list]);

  const recheck = useCallback(async (): Promise<Connection> => {
    if (!active) return { state: "checking" };
    setConnection({ state: "checking" });
    const next = toConnection(await checkHub(active.url, active.token));
    setConnection(next);
    return next;
  }, [active]);

  const pair = useCallback(
    async (pairing: Pairing): Promise<HubCheck> => {
      const check = await checkHub(pairing.url, pairing.token);
      if (!check.ok) return check;
      await hubStore.save({ url: pairing.url, token: pairing.token, label: check.label });
      setConnection({ state: "connected" });
      await reload();
      return check;
    },
    [reload],
  );

  const setActive = useCallback(
    async (id: string) => {
      await hubStore.setActive(id);
      setConnection({ state: "checking" });
      await reload();
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await hubStore.remove(id);
      setConnection({ state: "checking" });
      await reload();
    },
    [reload],
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
