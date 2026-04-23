import { Columns2, Rows2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { buildTreeFromConfig, type PaneMetadata } from "../lib/terminal-config-utils";
import {
  countLeaves,
  createLeaf,
  type LeafNode,
  loadPaneMeta,
  loadTree,
  removeLeaf,
  type SplitNode,
  savePaneMeta,
  saveTree,
  splitLeaf,
  type TreeNode,
  updateNodeSizes,
} from "../lib/terminal-split-tree";
import { trpc } from "../lib/trpc-client";

// Lazy-load TerminalPanel to avoid importing @xterm CJS during SSR
const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

interface SplitTerminalContainerProps {
  workspaceId: string;
  visible: boolean;
}

export function SplitTerminalContainer({ workspaceId, visible }: SplitTerminalContainerProps) {
  const [tree, setTree] = useState<TreeNode>(() => {
    const stored = loadTree(workspaceId);
    if (stored) return stored;
    // Temporary leaf — don't save to localStorage yet so the useEffect
    // can detect "no stored tree" and attempt to fetch server config first.
    return createLeaf();
  });

  const [paneMetadata, setPaneMetadata] = useState<Record<string, PaneMetadata>>(() => {
    const stored = loadPaneMeta(workspaceId);
    return (stored as Record<string, PaneMetadata>) ?? {};
  });

  const [focusTerminalId, setFocusTerminalId] = useState<string | null>(null);

  // Track whether we've already applied config for this workspace
  // so we don't re-apply on every re-mount
  const configAppliedRef = useRef<string | null>(null);

  // On mount or workspace change: check for config-driven layout
  useEffect(() => {
    const storedTree = loadTree(workspaceId);
    if (storedTree) {
      // If a tree already exists in localStorage, use it as-is
      setTree(storedTree);
      const storedMeta = loadPaneMeta(workspaceId);
      setPaneMetadata((storedMeta as Record<string, PaneMetadata>) ?? {});
      setFocusTerminalId(null);
      return;
    }

    // No stored tree — try to build from server config
    if (configAppliedRef.current === workspaceId) return;

    let cancelled = false;

    trpc.workspace.getTerminalConfig
      .query({ workspaceId })
      .then(({ config }) => {
        if (cancelled) return;
        configAppliedRef.current = workspaceId;

        if (config) {
          const result = buildTreeFromConfig(config);
          saveTree(workspaceId, result.tree);
          savePaneMeta(workspaceId, result.paneMetadata);
          setTree(result.tree);
          setPaneMetadata(result.paneMetadata);
          setFocusTerminalId(result.focusTerminalId);
        } else {
          // No config — keep the default single leaf
          const fresh = createLeaf();
          saveTree(workspaceId, fresh);
          setTree(fresh);
          setPaneMetadata({});
          setFocusTerminalId(null);
        }
      })
      .catch(() => {
        // Failed to fetch config — keep the default leaf
        if (!cancelled) {
          configAppliedRef.current = workspaceId;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const handleSplit = useCallback(
    (terminalId: string, direction: "horizontal" | "vertical") => {
      setTree((prev) => {
        const next = splitLeaf(prev, terminalId, direction);
        saveTree(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  const handleClose = useCallback(
    (terminalId: string) => {
      // Kill the PTY on the backend via a one-shot WebSocket close message.
      // TerminalPanel unmount does NOT kill PTYs (so they survive workspace
      // switches). Only an explicit user close action kills them.
      killTerminalRemotely(workspaceId, terminalId);

      setTree((prev) => {
        const next = removeLeaf(prev, terminalId) ?? createLeaf();
        saveTree(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  const totalLeaves = countLeaves(tree);

  return (
    <div className="h-full w-full">
      <RenderNode
        node={tree}
        workspaceId={workspaceId}
        visible={visible}
        onSplit={handleSplit}
        onClose={handleClose}
        totalLeaves={totalLeaves}
        paneMetadata={paneMetadata}
        focusTerminalId={focusTerminalId}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recursive tree renderer
// ---------------------------------------------------------------------------

interface RenderNodeProps {
  node: TreeNode;
  workspaceId: string;
  visible: boolean;
  onSplit: (terminalId: string, direction: "horizontal" | "vertical") => void;
  onClose: (terminalId: string) => void;
  totalLeaves: number;
  paneMetadata: Record<string, PaneMetadata>;
  focusTerminalId: string | null;
}

function RenderNode({
  node,
  workspaceId,
  visible,
  onSplit,
  onClose,
  totalLeaves,
  paneMetadata,
  focusTerminalId,
}: RenderNodeProps) {
  if (node.type === "leaf") {
    return (
      <LeafPane
        node={node}
        workspaceId={workspaceId}
        visible={visible}
        onSplit={onSplit}
        onClose={onClose}
        showClose={totalLeaves > 1}
        metadata={paneMetadata[node.terminalId]}
        autoFocus={focusTerminalId === node.terminalId}
      />
    );
  }

  // SplitNode — render a Group with two children separated by a Separator
  return (
    <SplitPane
      node={node}
      workspaceId={workspaceId}
      visible={visible}
      onSplit={onSplit}
      onClose={onClose}
      totalLeaves={totalLeaves}
      paneMetadata={paneMetadata}
      focusTerminalId={focusTerminalId}
    />
  );
}

// ---------------------------------------------------------------------------
// Split pane: Group with two panels and persistent sizes
// ---------------------------------------------------------------------------

interface SplitPaneProps {
  node: SplitNode;
  workspaceId: string;
  visible: boolean;
  onSplit: (terminalId: string, direction: "horizontal" | "vertical") => void;
  onClose: (terminalId: string) => void;
  totalLeaves: number;
  paneMetadata: Record<string, PaneMetadata>;
  focusTerminalId: string | null;
}

function SplitPane({
  node,
  workspaceId,
  visible,
  onSplit,
  onClose,
  totalLeaves,
  paneMetadata,
  focusTerminalId,
}: SplitPaneProps) {
  const orientation = node.direction === "horizontal" ? "horizontal" : "vertical";

  const defaultLayout = node.sizes
    ? { left: node.sizes[0], right: node.sizes[1] }
    : { left: 50, right: 50 };

  // Skip the first onLayoutChanged callback — react-resizable-panels fires it
  // on initial mount with a computed layout that may differ from defaultLayout
  // (e.g. before the container has its final CSS dimensions). Saving those
  // values would overwrite the correct stored sizes.
  const skipNextCallback = useRef(true);

  // Persist sizes directly to localStorage on resize — no React state update.
  // This avoids re-renders that fight with the Group's internal layout state.
  const handleLayoutChanged = useCallback(
    (layout: Record<string, number>) => {
      if (skipNextCallback.current) {
        skipNextCallback.current = false;
        return;
      }
      const left = layout.left;
      const right = layout.right;
      if (left != null && right != null) {
        const stored = loadTree(workspaceId);
        if (stored) {
          saveTree(workspaceId, updateNodeSizes(stored, node.nodeId, [left, right]));
        }
      }
    },
    [node.nodeId, workspaceId],
  );

  return (
    <Group
      orientation={orientation}
      defaultLayout={defaultLayout}
      onLayoutChanged={handleLayoutChanged}
    >
      <Panel id="left" minSize={10}>
        <RenderNode
          node={node.children[0]}
          workspaceId={workspaceId}
          visible={visible}
          onSplit={onSplit}
          onClose={onClose}
          totalLeaves={totalLeaves}
          paneMetadata={paneMetadata}
          focusTerminalId={focusTerminalId}
        />
      </Panel>
      <Separator
        className={
          orientation === "horizontal"
            ? "w-1 bg-neutral-700/50 hover:bg-blue-500/50 transition-colors"
            : "h-1 bg-neutral-700/50 hover:bg-blue-500/50 transition-colors"
        }
      />
      <Panel id="right" minSize={10}>
        <RenderNode
          node={node.children[1]}
          workspaceId={workspaceId}
          visible={visible}
          onSplit={onSplit}
          onClose={onClose}
          totalLeaves={totalLeaves}
          paneMetadata={paneMetadata}
          focusTerminalId={focusTerminalId}
        />
      </Panel>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Leaf pane: toolbar + terminal
// ---------------------------------------------------------------------------

interface LeafPaneProps {
  node: LeafNode;
  workspaceId: string;
  visible: boolean;
  onSplit: (terminalId: string, direction: "horizontal" | "vertical") => void;
  onClose: (terminalId: string) => void;
  showClose: boolean;
  metadata?: PaneMetadata;
  autoFocus?: boolean;
}

function LeafPane({
  node,
  workspaceId,
  visible,
  onSplit,
  onClose,
  showClose,
  metadata,
  autoFocus,
}: LeafPaneProps) {
  return (
    <div className="flex h-full w-full flex-col">
      {/* Compact toolbar */}
      <div className="flex h-7 shrink-0 items-center border-b border-neutral-700/50 px-1">
        {metadata?.name && (
          <span className="mr-auto truncate pl-1 text-xs text-neutral-400">{metadata.name}</span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <ToolbarButton
            title="Split Horizontal"
            onClick={() => onSplit(node.terminalId, "horizontal")}
          >
            <Columns2 className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            title="Split Vertical"
            onClick={() => onSplit(node.terminalId, "vertical")}
          >
            <Rows2 className="size-3.5" />
          </ToolbarButton>
          {showClose && (
            <ToolbarButton title="Close Terminal" onClick={() => onClose(node.terminalId)}>
              <X className="size-3.5" />
            </ToolbarButton>
          )}
        </div>
      </div>
      {/* Terminal */}
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <TerminalPanel
            workspaceId={workspaceId}
            terminalId={node.terminalId}
            visible={visible}
            paneMetadata={metadata}
            autoFocus={autoFocus}
          />
        </Suspense>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar button
// ---------------------------------------------------------------------------

function ToolbarButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex items-center justify-center rounded p-1 text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-200 transition-colors"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helper: kill a PTY on the backend via a one-shot WebSocket
// ---------------------------------------------------------------------------

function killTerminalRemotely(workspaceId: string, terminalId: string): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${proto}//${location.host}/terminal?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${encodeURIComponent(terminalId)}`,
  );
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "close" }));
    ws.close();
  };
  ws.onerror = () => ws.close();
}
