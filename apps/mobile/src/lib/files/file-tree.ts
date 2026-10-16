import { joinPath } from "./paths.ts";

export interface FileEntry {
  name: string;
  type: "file" | "directory";
}

/** One visible line of the tree. */
export interface TreeRow {
  path: string;
  name: string;
  type: "file" | "directory";
  depth: number;
  expanded: boolean;
  /** A folder that is open and whose listing has not arrived. */
  loading: boolean;
}

/**
 * The rows the tree shows: the root's entries, and below each open folder its entries one level
 * deeper. `listings` holds every folder read so far, by path ("" is the root).
 */
export function flattenTree(
  listings: ReadonlyMap<string, readonly FileEntry[]>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (dir: string, depth: number) => {
    for (const entry of listings.get(dir) ?? []) {
      const path = joinPath(dir, entry.name);
      const open = entry.type === "directory" && expanded.has(path);
      rows.push({
        path,
        name: entry.name,
        type: entry.type,
        depth,
        expanded: open,
        loading: open && !listings.has(path),
      });
      if (open) visit(path, depth + 1);
    }
  };
  visit("", 0);
  return rows;
}
