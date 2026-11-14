import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc-client";

export type VaultItem = Awaited<ReturnType<typeof trpc.vault.list.query>>["items"][number];

/**
 * The one React Query key for the vault list. Every Settings screen that lists vault items
 * reads it through `useVaultItems`, so the cache holds a single shape (the bare `items` array).
 * Invalidate this key after a vault write.
 */
export const VAULT_ITEMS_KEY = ["vault.list"] as const;

export function useVaultItems(options?: { enabled?: boolean }) {
  return useQuery<VaultItem[]>({
    queryKey: VAULT_ITEMS_KEY,
    queryFn: async () => (await trpc.vault.list.query()).items,
    enabled: options?.enabled,
    // A credential can be added from another screen (the MCP OAuth flow), so refetch on every mount.
    staleTime: 0,
  });
}
