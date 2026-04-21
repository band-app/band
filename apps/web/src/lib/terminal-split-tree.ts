// Pure functions + types for the binary split tree used by terminal splits.

/** crypto.randomUUID() is unavailable in insecure contexts (plain HTTP on non-localhost). */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: build a v4 UUID from crypto.getRandomValues (available in all browsers)
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type SplitDirection = "horizontal" | "vertical";

export interface SplitNode {
  type: "split";
  nodeId: string;
  direction: SplitDirection;
  children: [TreeNode, TreeNode];
  sizes?: [number, number]; // percentage of each child, e.g. [50, 50]
}

export interface LeafNode {
  type: "leaf";
  terminalId: string;
}

export type TreeNode = SplitNode | LeafNode;

/**
 * Create a new leaf node with a random terminalId.
 */
export function createLeaf(): LeafNode {
  return { type: "leaf", terminalId: uuid() };
}

/**
 * Replace the leaf identified by `targetId` with a split containing
 * the original leaf and a new leaf in the given direction.
 * Returns a new tree (immutable).
 */
export function splitLeaf(tree: TreeNode, targetId: string, direction: SplitDirection): TreeNode {
  if (tree.type === "leaf") {
    if (tree.terminalId === targetId) {
      return {
        type: "split",
        nodeId: uuid(),
        direction,
        children: [tree, createLeaf()],
        sizes: [50, 50],
      };
    }
    return tree;
  }

  // SplitNode — recurse into children
  const [left, right] = tree.children;
  const newLeft = splitLeaf(left, targetId, direction);
  const newRight = splitLeaf(right, targetId, direction);

  if (newLeft === left && newRight === right) {
    return tree; // nothing changed
  }

  return { ...tree, children: [newLeft, newRight] };
}

/**
 * Remove the leaf identified by `targetId`.
 * The sibling is promoted to replace the parent split.
 * Returns `null` if the last leaf is removed (tree is now empty).
 */
export function removeLeaf(tree: TreeNode, targetId: string): TreeNode | null {
  if (tree.type === "leaf") {
    return tree.terminalId === targetId ? null : tree;
  }

  const [left, right] = tree.children;

  // Check if target is a direct child
  if (left.type === "leaf" && left.terminalId === targetId) {
    return right; // promote sibling
  }
  if (right.type === "leaf" && right.terminalId === targetId) {
    return left; // promote sibling
  }

  // Recurse into children
  const newLeft = removeLeaf(left, targetId);
  const newRight = removeLeaf(right, targetId);

  if (newLeft === null) return newRight;
  if (newRight === null) return newLeft;

  if (newLeft === left && newRight === right) {
    return tree; // nothing changed
  }

  return { ...tree, children: [newLeft, newRight] };
}

/**
 * Collect all terminal IDs from the tree (all leaf nodes).
 */
export function getAllTerminalIds(tree: TreeNode): string[] {
  if (tree.type === "leaf") {
    return [tree.terminalId];
  }
  return [...getAllTerminalIds(tree.children[0]), ...getAllTerminalIds(tree.children[1])];
}

/**
 * Count the total number of leaves in the tree.
 */
export function countLeaves(tree: TreeNode): number {
  if (tree.type === "leaf") return 1;
  return countLeaves(tree.children[0]) + countLeaves(tree.children[1]);
}

/**
 * Update the sizes of a specific split node identified by nodeId.
 * Returns a new tree (immutable).
 */
export function updateNodeSizes(tree: TreeNode, nodeId: string, sizes: [number, number]): TreeNode {
  if (tree.type === "leaf") return tree;

  if (tree.nodeId === nodeId) {
    return { ...tree, sizes };
  }

  const [left, right] = tree.children;
  const newLeft = updateNodeSizes(left, nodeId, sizes);
  const newRight = updateNodeSizes(right, nodeId, sizes);

  if (newLeft === left && newRight === right) {
    return tree; // nothing changed
  }

  return { ...tree, children: [newLeft, newRight] };
}

const STORAGE_PREFIX = "band:terminal-splits:";

/**
 * Persist the split tree for a workspace to localStorage.
 */
export function saveTree(workspaceId: string, tree: TreeNode): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${workspaceId}`, JSON.stringify(tree));
  } catch {
    // localStorage may be full or unavailable
  }
}

/**
 * Load the persisted split tree for a workspace from localStorage.
 * Returns `null` if nothing is stored or the data is corrupt.
 */
export function loadTree(workspaceId: string): TreeNode | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${workspaceId}`);
    return raw ? (JSON.parse(raw) as TreeNode) : null;
  } catch {
    return null;
  }
}
