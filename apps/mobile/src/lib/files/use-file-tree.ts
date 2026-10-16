import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHubSession } from "../hub-session";
import { type FileEntry, flattenTree } from "./file-tree";

/**
 * The explorer's tree: the root's listing, and a folder's listing the first time it opens. Each
 * folder is one `worktree.listFiles` call, so a repo with thousands of files only costs the
 * folders the user opens. `refresh` reads the root and every open folder again.
 */
export function useFileTree(worktreeId: string) {
  const { client } = useHubSession();
  const [listings, setListings] = useState<ReadonlyMap<string, readonly FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(
    async (path: string) => {
      const result = await client.worktree.listFiles.query({ worktreeId, path });
      if (!live.current) return;
      setListings((prev) => new Map(prev).set(path, result.entries));
    },
    [client, worktreeId],
  );

  useEffect(() => {
    setError(null);
    load("").catch((e: unknown) => {
      if (live.current) setError(e instanceof Error ? e.message : "Couldn't read the files");
    });
  }, [load]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      // A folder read before keeps its listing, which a refresh updates.
      if (!listings.has(path) && !pending.current.has(path)) {
        pending.current.add(path);
        load(path)
          .catch((e: unknown) => {
            if (!live.current) return;
            // A folder that failed to open goes back to closed, so its row doesn't spin forever.
            setExpanded((prev) => {
              const next = new Set(prev);
              next.delete(path);
              return next;
            });
            setError(e instanceof Error ? e.message : "Couldn't read the folder");
          })
          .finally(() => pending.current.delete(path));
      }
    },
    [listings, load],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setError(null);
      const open = ["", ...expanded];
      const results = await Promise.all(
        open.map((path) =>
          client.worktree.listFiles
            .query({ worktreeId, path })
            // A folder deleted since it was opened is dropped from the listings.
            .then((r) => [path, r.entries] as const)
            .catch(() => [path, null] as const),
        ),
      );
      if (!live.current) return;
      setListings((prev) => {
        const next = new Map(prev);
        for (const [path, entries] of results) {
          if (entries) next.set(path, entries);
          // A failed read of the root keeps the last listing, so the tree stays on screen.
          else if (path !== "") next.delete(path);
        }
        return next;
      });
      if (results.find(([q]) => q === "")?.[1] === null) setError("Couldn't refresh the files");
      setExpanded((prev) => new Set([...prev].filter((p) => results.find(([q]) => q === p)?.[1])));
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : "Couldn't refresh");
    } finally {
      if (live.current) setRefreshing(false);
    }
  }, [client, worktreeId, expanded]);

  const rows = useMemo(() => flattenTree(listings, expanded), [listings, expanded]);
  return { rows, toggle, refresh, refreshing, error, ready: listings.has("") };
}
