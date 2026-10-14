import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc-client";

type HostList = Awaited<ReturnType<typeof trpc.hosts.list.query>>["hosts"];

const HOSTS_KEY = ["hosts.list"] as const;

/** The hosts the hub lists, kept fresh so a worker that drops shows as offline within seconds. */
export function useHostList(): HostList {
  const hosts = useQuery<HostList>({
    queryKey: HOSTS_KEY,
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    refetchInterval: 5_000,
  });
  return hosts.data ?? [];
}

/**
 * Whether a worktree's host is a worker the hub lists as not online. The hub's own host and an
 * unknown host count as up, so nothing shows offline before the first answer.
 */
export function useHostOffline(hostId: string | null | undefined): boolean {
  const hosts = useHostList();
  if (!hostId || hostId === "local") return false;
  const host = hosts.find((h) => h.id === hostId);
  return host !== undefined && host.status !== "online";
}

/** What the card and the notice of an offline worktree say about its host. */
export interface HostSeen {
  offline: boolean;
  name: string;
  /** Epoch ms the hub last saw the worker, or null when it never did. */
  lastSeenAt: number | null;
}

/** The host's name and when the hub last saw it, with the same "up until proven offline" rule as `useHostOffline`. */
export function useHostSeen(hostId: string | null | undefined): HostSeen {
  const hosts = useHostList();
  const host = !hostId || hostId === "local" ? undefined : hosts.find((h) => h.id === hostId);
  return {
    offline: host !== undefined && host.status !== "online",
    name: host?.name || hostId || "",
    lastSeenAt: host?.lastSeenAt ?? null,
  };
}

/** "3 minutes ago" style text for a timestamp. */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
