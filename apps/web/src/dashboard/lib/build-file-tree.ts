import type { ChangeEntry } from "../types";

export interface FileTreeNode {
  /** Display name — for compressed dirs this could be "src/components" */
  name: string;
  /** Full path from root (the entry's path for leaf files) */
  path: string;
  /** The change shown on this row — only set on leaf file nodes */
  entry?: ChangeEntry;
  /** Children nodes — only set on directory nodes, sorted: dirs first, then files, alphabetically */
  children?: FileTreeNode[];
  /** Number of files under a directory node */
  fileCount?: number;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  entry?: ChangeEntry;
}

/**
 * Builds a hierarchical file tree from a flat list of changes.
 *
 * Features:
 * - Path compression: single-child directory chains merge into one node
 *   (e.g., "src/lib" instead of nested src → lib)
 * - Sorting: directories first (alphabetical), then files (alphabetical)
 */
export function buildFileTree(entries: ChangeEntry[]): FileTreeNode[] {
  // 1. Build trie from flat paths
  const root: TrieNode = { children: new Map() };

  for (const entry of entries) {
    const parts = entry.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.children.has(part)) {
        current.children.set(part, { children: new Map() });
      }
      current = current.children.get(part)!;

      // Mark leaf node with its change
      if (i === parts.length - 1) {
        current.entry = entry;
      }
    }
  }

  // 2. Convert trie to FileTreeNode[] with path compression
  return trieToNodes(root, "");
}

function trieToNodes(trie: TrieNode, parentPath: string): FileTreeNode[] {
  const nodes: FileTreeNode[] = [];

  for (const [name, child] of trie.children) {
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    const isFile = child.entry !== undefined && child.children.size === 0;

    if (isFile) {
      nodes.push({ name, path: fullPath, entry: child.entry });
    } else {
      // Directory node — apply path compression
      let compressedName = name;
      let compressedPath = fullPath;
      let current = child;

      // Compress single-child directory chains (only when child is also a directory)
      while (current.children.size === 1 && current.entry === undefined) {
        const [childName, grandchild] = current.children.entries().next().value as [
          string,
          TrieNode,
        ];
        const isChildFile = grandchild.entry !== undefined && grandchild.children.size === 0;
        if (isChildFile) break; // Don't compress a dir with a single file child
        compressedName = `${compressedName}/${childName}`;
        compressedPath = `${compressedPath}/${childName}`;
        current = grandchild;
      }

      const children = trieToNodes(current, compressedPath);
      const fileCount = children.reduce((n, c) => n + (c.children ? (c.fileCount ?? 0) : 1), 0);
      nodes.push({ name: compressedName, path: compressedPath, children, fileCount });
    }
  }

  // Sort: directories first (alphabetical), then files (alphabetical)
  nodes.sort((a, b) => {
    const aIsDir = a.children !== undefined;
    const bIsDir = b.children !== undefined;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}
