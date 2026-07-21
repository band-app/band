import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";
import { TerminalSquare, X } from "lucide-react";
import type React from "react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cycleGridGroups, selectNeighbourBeforeRemove } from "../lib/dockview-section-actions";
import { newTerminalId } from "../lib/leaf-instance-ids";
import { disposeTerminal } from "../lib/terminal-cache";
import {
  readNestedLayout,
  registerPaneOwner,
  registerTerminalSplitDockview,
  unregisterPaneOwner,
  writeNestedLayout,
} from "../lib/terminal-split-registry";
import { trpc } from "../lib/trpc-client";
import { PanelVisibilityContext, usePanelVisibility } from "./panel-visibility-context";

// Lazy-load TerminalPanel to avoid importing @xterm CJS during SSR (mirrors the
// outer dockview's lazy import).
const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

// ---------------------------------------------------------------------------
// A nested dockview per terminal LEAF. Each pane is a single-panel group that
// renders one `TerminalPanel` (its own terminalId + PTY). Splits create new
// GROUPS (never tabs), so no group ever holds >1 tab — panes, not tabs. Panes
// are drag-reorderable (dockview's native tab drag) and resizable (sashes);
// ⌘D / ⌘⇧D split right / below, ⌘[ / ⌘] cycle. The OUTER terminal tab's title
// tracks the last-focused pane's title.
// ---------------------------------------------------------------------------

interface PaneParams {
  workspaceId: string;
  terminalId: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  autoFocus?: boolean;
}

const nestedTheme: DockviewTheme = {
  name: "band",
  className: "dockview-theme-band dockview-terminal-split",
};

// Per-nested-dockview close handler, keyed by the nested dockview's `api.id` so
// the STABLE pane-header component resolves to the right leaf's closer (mirrors
// the `leafActionsByApiId` pattern in the outer dockview).
const paneCloseByApiId = new Map<string, { current: (terminalId: string) => void }>();

// ---------------------------------------------------------------------------
// Pane content
// ---------------------------------------------------------------------------

function TerminalPanePanel({ params, api }: IDockviewPanelProps<PaneParams>) {
  // The nested dockview lives inside the outer TerminalLeaf, which lives inside
  // the outer panel's `PanelVisibilityContext` — so this reports the OUTER
  // leaf's visibility. Panes are 1-per-group, so a pane is visible exactly when
  // the terminal tab is the shown leaf; that's the right gate for attach/park.
  const { visible } = usePanelVisibility();
  const onTitleChange = useCallback((title: string) => api.setTitle(title), [api]);

  if (!params.workspaceId || !params.terminalId) return null;

  const paneMetadata =
    params.command || params.cwd || params.env
      ? { command: params.command, cwd: params.cwd, env: params.env }
      : undefined;

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`term-pane__${params.terminalId}`}
    >
      <Suspense fallback={null}>
        <TerminalPanel
          workspaceId={params.workspaceId}
          terminalId={params.terminalId}
          visible={visible}
          paneMetadata={paneMetadata}
          autoFocus={params.autoFocus}
          onTitleChange={onTitleChange}
        />
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pane header (the nested `tabComponent`): terminal icon + title + close.
// The header element is dockview's drag source, so this is also what the user
// grabs to reorder panes. The close (×) shows only when there's >1 pane —
// a lone pane is closed via the OUTER terminal tab (matching the old inner
// terminal container). When there's a single pane the whole header is hidden
// via CSS (`.dockview-terminal-split--single`), so an unsplit terminal shows
// no redundant inner title bar.
// ---------------------------------------------------------------------------

function TerminalPaneHeader(props: IDockviewPanelHeaderProps<PaneParams>) {
  const [title, setTitle] = useState(props.api.title ?? "Terminal");
  const [paneCount, setPaneCount] = useState(props.containerApi.panels.length);

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? "Terminal"));
    return () => d.dispose();
  }, [props.api]);

  useEffect(() => {
    const cApi = props.containerApi;
    const update = () => setPaneCount(cApi.panels.length);
    const d1 = cApi.onDidAddPanel(update);
    const d2 = cApi.onDidRemovePanel(update);
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [props.containerApi]);

  const apiId = props.containerApi.id;
  const terminalId = props.params.terminalId;
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      paneCloseByApiId.get(apiId)?.current?.(terminalId);
    },
    [apiId, terminalId],
  );

  return (
    <div className="dv-default-tab" data-testid={`term-pane-header__${terminalId}`}>
      <div className="flex min-w-0 items-center gap-1.5">
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{title}</span>
      </div>
      {paneCount > 1 && (
        <button
          type="button"
          className="ml-1 inline-flex size-4 items-center justify-center rounded-sm opacity-60 transition-colors hover:bg-accent hover:opacity-100"
          onClick={handleClose}
          title="Close pane"
          data-testid={`term-pane-close__${terminalId}`}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

const nestedComponents = { pane: TerminalPanePanel };
const nestedTabComponents = { pane: TerminalPaneHeader };

// ---------------------------------------------------------------------------
// Layout (de)serialization for the nested split — params are re-derived from
// the panel id on restore (panel id === terminalId), so no stale callbacks or
// metadata persist. Mirrors the outer dockview's strip/reinject dance.
// ---------------------------------------------------------------------------

function isNestedLayout(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.grid === "object" && typeof o.panels === "object";
}

function stripParams(layout: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(layout));
  const panels = clone?.panels as Record<string, { params?: unknown }> | undefined;
  if (panels) for (const id of Object.keys(panels)) panels[id].params = {};
  return clone;
}

function reinjectParams(layout: unknown, workspaceId: string): unknown {
  const clone = JSON.parse(JSON.stringify(layout));
  const panels = clone?.panels as Record<string, { params?: unknown }> | undefined;
  if (panels) {
    for (const id of Object.keys(panels)) panels[id].params = { workspaceId, terminalId: id };
  }
  return clone;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface TerminalSplitLeafProps {
  workspaceId: string;
  /** The OUTER leaf id (=== the primary/first pane's terminalId). */
  leafId: string;
  /** The primary pane's terminalId — its PTY was already spawned by the outer
   *  dockview when the terminal tab was created, so the nested dockview only
   *  RENDERS it (no `terminal.create`). */
  primaryTerminalId: string;
  /** Metadata for the primary pane (from workspace terminal config). */
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  autoFocus?: boolean;
  /** OUTER leaf visibility (from `usePanelVisibility`). */
  visible: boolean;
  /** Mobile: single pane only — no split keys, no drag. */
  mobile: boolean;
  /** Push the last-focused pane's title to the OUTER terminal tab. */
  onActivePaneTitleChange: (title: string) => void;
  /** Close the whole terminal tab (⌘W / a lone-pane close routes here). */
  onCloseLeaf: () => void;
}

function addPane(
  api: DockviewApi,
  params: PaneParams,
  position?: Parameters<DockviewApi["addPanel"]>[0]["position"],
  // `inactive` adds the pane WITHOUT activating/focusing it. Crucial for the
  // initial seed/restore: an active add focuses the nested group, and that
  // focus bubbles up so the OUTER dockview activates the terminal panel —
  // stealing default-active from the chat leaf. Only a user-initiated split
  // (or an explicit new-terminal autoFocus) should grab focus.
  inactive?: boolean,
): void {
  api.addPanel({
    id: params.terminalId,
    component: "pane",
    tabComponent: "pane",
    title: "Terminal",
    params,
    ...(position ? { position } : {}),
    ...(inactive ? { inactive: true } : {}),
    // biome-ignore lint/suspicious/noExplicitAny: dockview addPanel position typing
  } as any);
}

export function TerminalSplitLeaf({
  workspaceId,
  leafId,
  primaryTerminalId,
  command,
  cwd,
  env,
  autoFocus,
  visible,
  mobile,
  onActivePaneTitleChange,
  onCloseLeaf,
}: TerminalSplitLeafProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isRestoringRef = useRef(false);
  const normalizingRef = useRef(false);
  const splitDisposerRef = useRef<(() => void) | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onTitleRef = useRef(onActivePaneTitleChange);
  onTitleRef.current = onActivePaneTitleChange;
  const onCloseLeafRef = useRef(onCloseLeaf);
  onCloseLeafRef.current = onCloseLeaf;

  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // ---- persistence ----
  // Write the nested split layout NOW. Structural changes (pane add / remove /
  // move) flush immediately so a reload right after a split still restores the
  // panes; only resize churn (`onDidLayoutChange`) is debounced.
  const flushPersist = useCallback(() => {
    if (mobile) return; // mobile is single-pane; never persist split geometry
    if (isRestoringRef.current) return;
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const api = apiRef.current;
    if (!api) return;
    writeNestedLayout(workspaceId, leafId, stripParams(api.toJSON()));
  }, [workspaceId, leafId, mobile]);

  const schedulePersist = useCallback(() => {
    if (mobile) return;
    if (isRestoringRef.current) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      flushPersist();
    }, 400);
  }, [mobile, flushPersist]);

  // ---- single-pane header hiding (CSS class toggle) ----
  const refreshSingleClass = useCallback(() => {
    const el = containerRef.current;
    const api = apiRef.current;
    if (!el || !api) return;
    el.classList.toggle("dockview-terminal-split--single", api.groups.length <= 1);
  }, []);

  // ---- title propagation ----
  const activeTitleDisposerRef = useRef<{ dispose: () => void } | null>(null);
  const pushActiveTitle = useCallback(() => {
    const p = apiRef.current?.activePanel;
    onTitleRef.current(p?.title ?? "Terminal");
  }, []);

  // ---- close a pane ----
  const closePane = useCallback((terminalId: string) => {
    const api = apiRef.current;
    if (!api) return;
    // A lone pane is never closed from inside the nested dockview: the ×
    // button is hidden and ⌘W delegates to the outer tab. This guard is a
    // belt-and-braces backstop.
    if (api.panels.length <= 1) {
      onCloseLeafRef.current();
      return;
    }
    selectNeighbourBeforeRemove(api, terminalId);
    const panel = api.getPanel(terminalId);
    if (panel) api.removePanel(panel);
    disposeTerminal(terminalId);
    trpc.terminal.kill.mutate({ terminalId }).catch(() => {});
    unregisterPaneOwner(terminalId);
    requestAnimationFrame(() => {
      const active = api.activePanel;
      active?.view.content.element
        .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
        ?.focus();
    });
  }, []);
  const closePaneRef = useRef(closePane);
  closePaneRef.current = closePane;

  // ---- split ----
  const splitFocused = useCallback(
    (direction: "right" | "below") => {
      const api = apiRef.current;
      if (!api || mobile) return;
      const referenceGroup = api.activeGroup?.id;
      if (!referenceGroup) return;
      const id = newTerminalId();
      // Register ownership BEFORE creating the PTY so the `terminal-created`
      // echo doesn't spawn a stray OUTER tab for this pane.
      registerPaneOwner(id, leafId);
      addPane(api, { workspaceId, terminalId: id, autoFocus: true }, { referenceGroup, direction });
      trpc.terminal.create.mutate({ workspaceId, id }).catch(() => {});
    },
    [workspaceId, leafId, mobile],
  );

  // ---- center-merge guard: keep 1 pane per group ----
  // A drag dropped on a pane's CENTER would merge two panes into one group (a
  // 2-tab strip = the "nested tabs" we forbid). Re-split any group that ends up
  // with >1 panel by moving the extras into fresh adjacent groups.
  const normalizeGroups = useCallback(() => {
    if (normalizingRef.current) return;
    const api = apiRef.current;
    if (!api) return;
    const multi = api.groups.find((g) => g.panels.length > 1);
    if (!multi) return;
    normalizingRef.current = true;
    try {
      for (const panel of multi.panels.slice(1)) {
        const ng = api.addGroup({ referenceGroup: multi, direction: "right" });
        panel.api.moveTo({ group: ng });
      }
    } catch {
      // best-effort — if the move fails the worst case is a transient tab strip
    } finally {
      normalizingRef.current = false;
    }
  }, []);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      paneCloseByApiId.set(api.id, { current: closePaneRef.current });

      isRestoringRef.current = true;
      const saved = mobile ? null : readNestedLayout(workspaceId, leafId);
      let restored = false;
      if (saved && isNestedLayout(saved)) {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: dockview fromJSON typing
          api.fromJSON(reinjectParams(saved, workspaceId) as any);
          restored = api.panels.length > 0;
        } catch {
          api.clear();
        }
      }
      // Ensure the primary pane exists; seed a fresh single pane when there was
      // no (valid) saved layout. Add it INACTIVE then programmatically
      // `setActive()`: an active `addPanel` calls `focusContent()`, moving DOM
      // focus into the nested dockview — that focusin bubbles so the OUTER
      // dockview activates the terminal panel, stealing default-active from the
      // chat leaf on a fresh workspace. The inactive-add + `setActive` shows the
      // pane's content without the DOM focus grab. When the leaf was created with
      // an explicit autoFocus (⌘T new terminal), keep the focus.
      if (api.panels.length === 0) {
        addPane(
          api,
          { workspaceId, terminalId: primaryTerminalId, command, cwd, env, autoFocus },
          undefined,
          !autoFocus,
        );
        if (!autoFocus) api.getPanel(primaryTerminalId)?.api.setActive();
      }
      // Register ownership for every restored/seeded pane.
      for (const panel of api.panels) registerPaneOwner(panel.id, leafId);

      // Only when RESTORING a saved split: prune panes whose PTY died while the
      // tab was closed (e.g. a server restart), then re-seed the primary if that
      // emptied the leaf. Skipped for a fresh seed — the primary terminal was
      // just created (its `terminal.create` may still be in flight, and won't
      // exist at all for a not-yet-spawnable workspace), so pruning against
      // `terminal.list` would wrongly drop the pane we just added.
      if (restored) {
        void (async () => {
          try {
            const { terminals } = await trpc.terminal.list.query({ workspaceId });
            const live = new Set(terminals.map((t: { terminalId: string }) => t.terminalId));
            for (const panel of [...api.panels]) {
              if (!live.has(panel.id)) {
                api.removePanel(panel);
                disposeTerminal(panel.id);
                unregisterPaneOwner(panel.id);
              }
            }
            if (api.panels.length === 0) {
              registerPaneOwner(primaryTerminalId, leafId);
              addPane(api, { workspaceId, terminalId: primaryTerminalId }, undefined, true);
              api.getPanel(primaryTerminalId)?.api.setActive();
              trpc.terminal.create.mutate({ workspaceId, id: primaryTerminalId }).catch(() => {});
            }
          } catch {
            // offline / list failed — keep restored panes as-is
          }
        })();
      }

      setTimeout(() => {
        isRestoringRef.current = false;
      }, 0);

      // Register for the outer keydown handler's deferral + status-event
      // routing.
      splitDisposerRef.current?.();
      if (containerRef.current) {
        splitDisposerRef.current = registerTerminalSplitDockview(containerRef.current, api, leafId);
      }

      refreshSingleClass();
      pushActiveTitle();

      // Persistence + reactive wiring. Structural changes flush immediately
      // (survive a reload right after a split); resize churn is debounced.
      api.onDidLayoutChange(() => schedulePersist());
      api.onDidAddPanel(() => {
        normalizeGroups();
        refreshSingleClass();
        flushPersist();
      });
      api.onDidRemovePanel(() => {
        refreshSingleClass();
        flushPersist();
      });
      api.onDidMovePanel(() => {
        normalizeGroups();
        refreshSingleClass();
        flushPersist();
      });
      api.onDidAddGroup(refreshSingleClass);
      api.onDidRemoveGroup(refreshSingleClass);
      api.onDidActivePanelChange(() => {
        activeTitleDisposerRef.current?.dispose();
        const p = api.activePanel;
        if (p) activeTitleDisposerRef.current = p.api.onDidTitleChange(() => pushActiveTitle());
        pushActiveTitle();
      });

      // Cold-mount layout catch-up (mirrors the old inner terminal container).
      if (visibleRef.current && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          api.layout(Math.round(rect.width), Math.round(rect.height), true);
        }
      }
    },
    [
      workspaceId,
      leafId,
      primaryTerminalId,
      command,
      cwd,
      env,
      autoFocus,
      mobile,
      schedulePersist,
      flushPersist,
      refreshSingleClass,
      pushActiveTitle,
      normalizeGroups,
    ],
  );

  // Section-scoped keyboard shortcuts (only when focus is inside this leaf's
  // nested dockview). The OUTER handler defers d / [ / ] / w to us via
  // `findFocusedTerminalSplitDockview`, so we own them here.
  useEffect(() => {
    if (!visible) return;
    const refocusActive = () => {
      const panel = apiRef.current?.activePanel;
      panel?.view.content.element
        .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
        ?.focus();
    };
    const handler = (e: KeyboardEvent) => {
      if (!containerRef.current?.contains(document.activeElement)) return;
      const api = apiRef.current;
      if (!api) return;
      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (!e.shiftKey && (key === "[" || key === "]")) {
        e.preventDefault();
        e.stopPropagation();
        cycleGridGroups(api, key === "]" ? 1 : -1, () => requestAnimationFrame(refocusActive));
        return;
      }
      if (key === "w" && !e.shiftKey) {
        // Close the focused pane; a lone pane delegates to the outer tab.
        e.preventDefault();
        e.stopPropagation();
        if (api.panels.length <= 1) onCloseLeafRef.current();
        else if (api.activePanel) closePaneRef.current(api.activePanel.id);
        return;
      }
      if (key === "d") {
        if (e.metaKey && !e.ctrlKey && !mobile) {
          // ⌘D / ⌘⇧D → split right / below.
          e.preventDefault();
          e.stopPropagation();
          splitFocused(e.shiftKey ? "below" : "right");
        } else if (e.ctrlKey && !e.metaKey && !e.shiftKey) {
          // Ctrl+D → close the focused pane, but on a LONE pane let it fall
          // through to xterm so the shell receives EOF (exits).
          if (api.panels.length > 1 && api.activePanel) {
            e.preventDefault();
            e.stopPropagation();
            closePaneRef.current(api.activePanel.id);
          }
        } else if (e.metaKey || e.ctrlKey) {
          // Any other modifier-d combo: swallow so xterm doesn't see a stray ^D.
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, mobile, splitFocused]);

  // Detach on unmount.
  useEffect(() => {
    return () => {
      const api = apiRef.current;
      if (api) paneCloseByApiId.delete(api.id);
      splitDisposerRef.current?.();
      splitDisposerRef.current = null;
      activeTitleDisposerRef.current?.dispose();
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, []);

  // Force a synchronous re-layout when the outer terminal panel becomes visible
  // / resizes (dockview-core defers its own ResizeObserver by one rAF, which
  // otherwise paints the inner splitview at a stale width). Ported verbatim from
  // the pre-#643 DockviewTerminalContainer.
  useLayoutEffect(() => {
    if (!visible) return;
    const api = apiRef.current;
    const container = containerRef.current;
    if (!api || !container) return;
    let lastWidth = 0;
    let lastHeight = 0;
    const applyLayout = (width: number, height: number) => {
      const w = Math.round(width);
      const h = Math.round(height);
      if (w <= 0 || h <= 0) return;
      if (w === lastWidth && h === lastHeight) return;
      lastWidth = w;
      lastHeight = h;
      api.layout(w, h, true);
    };
    const rect = container.getBoundingClientRect();
    applyLayout(rect.width, rect.height);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyLayout(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [visible]);

  const visibilityValue = useMemo(() => ({ visible, wsActive: visible }), [visible]);

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col overflow-hidden">
      <PanelVisibilityContext.Provider value={visibilityValue}>
        <DockviewReact
          theme={nestedTheme}
          className="h-full"
          components={nestedComponents}
          tabComponents={nestedTabComponents}
          defaultTabComponent={TerminalPaneHeader}
          onReady={onReady}
          disableDnd={mobile}
          // One pane per group → make its header span the full width so it
          // reads as a pane title bar rather than a lone left-aligned tab.
          singleTabMode="fullwidth"
        />
      </PanelVisibilityContext.Provider>
    </div>
  );
}
