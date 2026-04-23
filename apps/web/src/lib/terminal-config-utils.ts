/**
 * Pure functions to convert a WorkspaceTerminalConfig layout tree
 * into the runtime TreeNode + PaneMetadata used by SplitTerminalContainer.
 *
 * This module runs on the client only (uses crypto.randomUUID).
 */

import type { TerminalLayoutNode, WorkspaceTerminalConfig } from "@band-app/dashboard-core";
import { createLeaf, type SplitDirection, type TreeNode } from "./terminal-split-tree";

// ---------------------------------------------------------------------------
// Pane metadata — persisted alongside the tree in localStorage
// ---------------------------------------------------------------------------

export interface PaneMetadata {
  name?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
}

export interface BuildResult {
  tree: TreeNode;
  paneMetadata: Record<string, PaneMetadata>; // terminalId -> metadata
  focusTerminalId: string | null;
}

// ---------------------------------------------------------------------------
// Max nesting depth to prevent pathological configs
// ---------------------------------------------------------------------------

const MAX_DEPTH = 10;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a validated WorkspaceTerminalConfig into the runtime split tree
 * and a map of per-pane metadata.
 */
export function buildTreeFromConfig(config: WorkspaceTerminalConfig): BuildResult {
  const paneMetadata: Record<string, PaneMetadata> = {};
  let focusTerminalId: string | null = null;

  function walk(node: TerminalLayoutNode, depth: number): TreeNode {
    if (depth > MAX_DEPTH) {
      // Too deep — collapse to a plain leaf
      return createLeaf();
    }

    if ("pane" in node) {
      const leaf = createLeaf();
      const meta: PaneMetadata = {};
      if (node.pane.name) meta.name = node.pane.name;
      if (node.pane.command) meta.command = node.pane.command;
      if (node.pane.cwd) meta.cwd = node.pane.cwd;
      if (node.pane.env) meta.env = node.pane.env;
      if (node.pane.focus) {
        meta.focus = true;
        focusTerminalId = leaf.terminalId;
      }
      if (Object.keys(meta).length > 0) {
        paneMetadata[leaf.terminalId] = meta;
      }
      return leaf;
    }

    // Split node
    const direction: SplitDirection = node.direction;
    const splitRatio = node.split ?? 0.5;
    const leftSize = Math.round(splitRatio * 100);
    const rightSize = 100 - leftSize;

    const leftChild = walk(node.children[0], depth + 1);
    const rightChild = walk(node.children[1], depth + 1);

    return {
      type: "split",
      nodeId: crypto.randomUUID(),
      direction,
      children: [leftChild, rightChild],
      sizes: [leftSize, rightSize],
    };
  }

  const tree = walk(config.layout, 0);
  return { tree, paneMetadata, focusTerminalId };
}
