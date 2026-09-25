import type { FileStatus } from "../types";

export interface FileTreeNode {
  /** Display name — for compressed dirs this could be "src/components" */
  name: string;
  /** Full path from root (the key into fileStatuses for leaf files) */
  path: string;
  /** File status badge — only set on leaf file nodes */
  status?: FileStatus;
  /** Children nodes — only set on directory nodes, sorted: dirs first, then files, alphabetically */
  children?: FileTreeNode[];
}

interface TrieNode {
  children: Map<string, TrieNode>;
  status?: FileStatus;
}

/**
 * Builds a hierarchical file tree from a flat map of file paths to statuses.
 *
 * Features:
 * - Path compression: single-child directory chains merge into one node
 *   (e.g., "src/lib" instead of nested src → lib)
 * - Sorting: directories first (alphabetical), then files (alphabetical)
 */
export function buildFileTree(fileStatuses: Record<string, FileStatus>): FileTreeNode[] {
  // 1. Build trie from flat paths
  const root: TrieNode = { children: new Map() };

  for (const [filePath, status] of Object.entries(fileStatuses)) {
    const parts = filePath.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.children.has(part)) {
        current.children.set(part, { children: new Map() });
      }
      current = current.children.get(part)!;

      // Mark leaf node with status
      if (i === parts.length - 1) {
        current.status = status;
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
    const isFile = child.status !== undefined && child.children.size === 0;

    if (isFile) {
      nodes.push({ name, path: fullPath, status: child.status });
    } else {
      // Directory node — apply path compression
      let compressedName = name;
      let compressedPath = fullPath;
      let current = child;

      // Compress single-child directory chains (only when child is also a directory)
      while (current.children.size === 1 && current.status === undefined) {
        const [childName, grandchild] = current.children.entries().next().value as [
          string,
          TrieNode,
        ];
        const isChildFile = grandchild.status !== undefined && grandchild.children.size === 0;
        if (isChildFile) break; // Don't compress a dir with a single file child
        compressedName = `${compressedName}/${childName}`;
        compressedPath = `${compressedPath}/${childName}`;
        current = grandchild;
      }

      const children = trieToNodes(current, compressedPath);
      nodes.push({ name: compressedName, path: compressedPath, children });
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
