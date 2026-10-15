import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc-client";

/**
 * Returns a function that turns a host id into the host's name, and falls back to "unknown host"
 * when the host has no name or is not in the list yet. The hub's own host is shown as "the hub".
 */
export function useHostNames(): (hostId: string | null | undefined) => string {
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
  });
  return (hostId) => {
    if (!hostId) return "the hub";
    const host = hosts.data?.find((h) => h.id === hostId);
    return host?.name?.trim() ? host.name : "unknown host";
  };
}

/**
 * The name of a worktree's host for a small card label, or undefined while the hub has a single
 * host (a single-machine install shows no label).
 */
export function useHostLabel(hostId: string | null | undefined): string | undefined {
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
  });
  if (!hosts.data || hosts.data.length < 2) return undefined;
  if (!hostId || hostId === "local") return "This hub";
  return hosts.data.find((h) => h.id === hostId)?.name?.trim() || "unknown host";
}
