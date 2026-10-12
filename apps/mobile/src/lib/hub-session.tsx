/**
 * Everything the signed-in screens share for one hub: the tRPC client, the React Query cache,
 * the status stream and the client-state store. The provider is keyed by the hub, so switching
 * hubs starts all of it again.
 *
 * Coming back from the background rebuilds the client, because iOS closes the sockets of a
 * suspended app, and re-reads the queries. The status feed keeps its last state on screen and
 * shows "reconnecting" until the new subscription's snapshot arrives.
 */

import { type ClientStateApi, ClientStateStore } from "@band-app/client/client-state";
import { createHubConnection, type HubClient } from "@band-app/client/hub-client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { createClientStateStorage } from "./client-state-storage";
import type { SavedHub } from "./hub-store";
import { StatusFeed, type StatusSource } from "./status-feed";
import type { StatusEvent } from "./status-state";

interface HubSessionValue {
  /** `sessionKey` of the hub this session belongs to. */
  key: string;
  client: HubClient;
  queryClient: QueryClient;
  feed: StatusFeed;
  clientState: ClientStateStore;
  /** False until the saved client state has been read and the server's copy merged in. */
  clientStateReady: boolean;
}

const HubSessionContext = createContext<HubSessionValue | null>(null);

/**
 * `fetch` that tells iOS not to keep the response. Without it the URL cache writes each request,
 * Authorization header included, to Library/Caches (the same reason `hub-api.ts` sends it).
 */
const noStoreFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return fetch(input, { ...init, headers });
};

function statusSource(getClient: () => HubClient): StatusSource {
  return {
    subscribe: (subscriber) =>
      getClient().status.stream.subscribe(undefined, {
        onStarted: () => subscriber.onStarted(),
        onData: (event) => subscriber.onData(event as StatusEvent),
        onError: () => subscriber.onError(),
        onComplete: () => subscriber.onComplete(),
      }),
  };
}

/** The id of a hub as saved, plus what makes its connection different: the session restarts on any of them. */
export function sessionKey(hub: SavedHub): string {
  return `${hub.id}|${hub.url}|${hub.token}`;
}

/**
 * Holds the session for `hub` without wrapping the screens in a keyed subtree: a hub switch
 * replaces the session behind a stable context, so the navigation stack is not rebuilt.
 */
export function HubSessionProvider({
  hub,
  children,
}: {
  hub: SavedHub | null;
  children: ReactNode;
}) {
  const [session, setSession] = useState<HubSessionValue | null>(null);
  const fallbackQueryClient = useMemo(() => new QueryClient(), []);
  const key = hub ? sessionKey(hub) : null;
  // A session of the hub that was active a moment ago is not this hub's.
  const current = session && session.key === key ? session : null;
  return (
    <>
      {hub ? <SessionHost key={key} hub={hub} onSession={setSession} /> : null}
      <QueryClientProvider client={current?.queryClient ?? fallbackQueryClient}>
        <HubSessionContext.Provider value={current}>{children}</HubSessionContext.Provider>
      </QueryClientProvider>
    </>
  );
}

function SessionHost({
  hub,
  onSession,
}: {
  hub: SavedHub;
  onSession: (session: HubSessionValue) => void;
}) {
  // Bumped each time the app returns from the background; a new number builds a new client.
  const [epoch, setEpoch] = useState(0);
  // The URL and token are the connection's inputs; `epoch` only forces a fresh socket.
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch is a rebuild trigger
  const connection = useMemo(
    () => createHubConnection({ hubUrl: hub.url, token: hub.token, fetch: noStoreFetch }),
    [hub.url, hub.token, epoch],
  );
  useEffect(() => () => connection.close(), [connection]);

  const clientRef = useRef(connection.client);
  clientRef.current = connection.client;

  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }),
    [],
  );

  const feed = useMemo(() => new StatusFeed(statusSource(() => clientRef.current)), []);
  const feedStarted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a rebuilt connection is the trigger to resubscribe
  useEffect(() => {
    // The first run starts the feed; later ones follow a rebuilt client.
    if (feedStarted.current) feed.retarget(statusSource(() => clientRef.current));
    else feed.start();
    feedStarted.current = true;
  }, [feed, connection]);
  useEffect(() => () => feed.stop(), [feed]);

  const [clientStateReady, setClientStateReady] = useState(false);
  const clientState = useMemo(() => {
    const storage = createClientStateStorage(AsyncStorage, hub.id);
    const store = new ClientStateStore({
      storage,
      // tRPC types an optional `value` that the store's entry type requires; the shapes match on the wire.
      getApi: async () => clientRef.current as unknown as ClientStateApi,
      deviceType: () => "mobile",
    });
    return { store, storage };
  }, [hub.id]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await clientState.storage.load();
      // Offline, `hydrate` keeps the local copy; it never rejects.
      await clientState.store.hydrate(null);
      if (!cancelled) setClientStateReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [clientState]);
  useEffect(() => {
    // Other devices' writes arrive on the status stream; a snapshot after a drop re-reads them.
    clientState.store.startSync((handler) => feed.onEvent(handler));
  }, [clientState, feed]);

  useEffect(() => {
    let last = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && last !== "active") {
        setEpoch((n) => n + 1);
        void queryClient.invalidateQueries();
      }
      last = next;
    });
    return () => sub.remove();
  }, [queryClient]);

  const key = sessionKey(hub);
  const client = connection.client;
  const store = clientState.store;
  useEffect(() => {
    onSession({ key, client, feed, queryClient, clientState: store, clientStateReady });
  }, [onSession, key, client, feed, queryClient, store, clientStateReady]);
  return null;
}

/** Renders `children` once the active hub's session exists. */
export function SessionGate({ children }: { children: ReactNode }) {
  const value = useContext(HubSessionContext);
  return value ? children : null;
}

export function useHubSession(): HubSessionValue {
  const value = useContext(HubSessionContext);
  if (!value) throw new Error("useHubSession needs a HubSessionProvider");
  return value;
}
