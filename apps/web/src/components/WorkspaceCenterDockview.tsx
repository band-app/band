import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import type { Extension } from "@codemirror/state";
import { useQuery } from "@tanstack/react-query";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";
import {
  AlignJustify,
  ClipboardCopy,
  Columns2,
  FileCode,
  GitCompare,
  Globe,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  RotateCcw,
  SquarePen,
  Terminal as TerminalIcon,
  TerminalSquare,
  X,
} from "lucide-react";
import type React from "react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AgentIcon,
  buildLspWsUrl,
  type ChatInsertDetail,
  createLspExtension,
  DiffFileContent,
  FileViewer,
  getLspLanguageId,
  getStoredViewMode,
  releaseLspClient,
  SearchBar,
  storeViewMode,
  type TerminalInsertDetail,
  toFileUri,
  toLspServerLang,
  useAdapter,
  useCapabilities,
  useDiffTarget,
  useSearch,
  useSettingsQuery,
  useWorkspacePath,
  type ViewMode,
} from "@/dashboard";
import { isUntitledPath, UNTITLED_PREFIX } from "../hooks/useFileTabs";
import type { TabFileState } from "../hooks/useTabState";
import { writeClipboardText } from "../lib/clipboard";
import {
  attachEdgeGroupDragVisibility,
  centralPanelPosition,
  ensureEdgeGroups,
  prepareMaximizeRestoreAnimation,
  registerInnerDockview,
} from "../lib/dockview-edge-groups";
import {
  cycleGridGroups,
  cycleTabsInActiveGroup,
  selectNeighbourBeforeRemove,
} from "../lib/dockview-section-actions";
import { isDesktop } from "../lib/is-desktop";
import {
  markBrowserFresh,
  markChatFresh,
  newBrowserId,
  newChatId,
  newTerminalId,
} from "../lib/leaf-instance-ids";
import { pathInside } from "../lib/path-inside";
import { disposeTerminal } from "../lib/terminal-cache";
import { trpc } from "../lib/trpc-client";
import { BrowserPaneComponent, type BrowserPaneParams, useFavicon } from "./BrowserPanel";
import { ChatPane, type CodingAgentDef, useChatPaneState } from "./ChatPane";
import { MarkdownPreview } from "./MarkdownPreview";
import { PanelVisibilityContext, usePanelVisibility } from "./panel-visibility-context";
import { setPerWorkspaceState } from "./per-workspace-state-store";
// `crossPanelHandlers` is a module-level mutable registry exported from
// SharedDockviewLayout. Importing it closes an ESM cycle (SharedDockviewLayout
// → WorkspaceCenterDockview → SharedDockviewLayout), but we only read it inside
// callbacks (call time, never module eval), so the live binding is always
// populated by then — same pattern the legacy containers use.
import { crossPanelHandlers } from "./SharedDockviewLayout";

// Lazy-load TerminalPanel to avoid importing @xterm (CJS) during SSR.
const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

// ---------------------------------------------------------------------------
// Leaf kinds
// ---------------------------------------------------------------------------
//
// The unified center dockview holds LEAF panels. Each panel's dockview
// `component` field is the leaf KIND; its `id` is the instance id
// (chatId / terminalId / browserId) for the per-instance kinds, or the
// prefixed `file:<path>` / `diff:<path>` for the per-path file/diff leaves
// opened from the right sidepanel (Explorer + Changes). Keeping the instance
// id AS the panel id means all the focus / insert / status-event plumbing
// carries over unchanged from the legacy per-app inner dockviews.
// ---------------------------------------------------------------------------

export type LeafKind = "chat" | "term" | "browser" | "file" | "diff";

const PANEL_ICONS: Record<string, React.FC<{ className?: string }>> = {
  chat: MessageSquare,
  term: TerminalIcon,
  browser: Globe,
};

const PANEL_SHORTCUTS: Record<string, string> = {};

// Every tab is a fixed 120px-wide row so the tab strip doesn't reflow as
// titles load/change. The title fills the remaining space and truncates; the
// full title is surfaced on hover (native `title` tooltip on the per-instance
// tabs; the singleton IconTab keeps its richer shortcut tooltip).
const TAB_TITLE_CLASS = "min-w-0 flex-1 truncate text-xs";
// Inner icon+title wrapper (grows to fill, leaving the close button pinned right).
const TAB_CONTENT_WRAP = "flex min-w-0 flex-1 items-center gap-1.5";

// Tab root fills the dockview `.dv-tab` wrapper (which is pinned to a fixed
// 120px in dockview-theme.css). `group` drives close-on-hover; the active-tab
// bottom accent is a CSS box-shadow on `.dv-active-tab` so it lands on the tab
// strip's bottom edge rather than floating inside the tab.
const TAB_ROOT_CLASS = "dv-default-tab group flex w-full items-center gap-1.5";

// Close button: always shown on the active tab; hidden on inactive tabs until
// the tab is hovered (the tab root carries the `group` class). Keeps the tab
// strip uncluttered while the active tab stays closable at a glance.
const CLOSE_BTN_BASE =
  "ml-0.5 inline-flex size-4 items-center justify-center rounded-sm transition-opacity hover:bg-accent";
function closeButtonClass(isActive: boolean): string {
  return `${CLOSE_BTN_BASE} ${isActive ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100"}`;
}

/** Track a tab's active state via its dockview panel api. */
function useTabActive(api: IDockviewPanelHeaderProps["api"]): boolean {
  const [isActive, setIsActive] = useState(api.isActive);
  useEffect(() => {
    const d = api.onDidActiveChange((e) => setIsActive(e.isActive));
    return () => d.dispose();
  }, [api]);
  return isActive;
}

/** Track a leaf's `preview` param (italic tab) reactively — it flips to
 *  `false` when the preview tab is pinned via `updateParameters`. */
function useTabPreview(api: IDockviewPanelHeaderProps["api"]): boolean {
  const [preview, setPreview] = useState(() => api.getParameters<{ preview?: boolean }>().preview);
  useEffect(() => {
    const d = api.onDidParametersChange(() => {
      setPreview(api.getParameters<{ preview?: boolean }>().preview);
    });
    return () => d.dispose();
  }, [api]);
  return preview === true;
}

const bandTheme: DockviewTheme = {
  name: "band",
  // `dockview-center-tabs` scopes the unified-center tab CSS (fixed 120px tab
  // width + active-tab bottom accent) so it never touches the legacy nested
  // chat/terminal tab strips still used by the mobile layout.
  className: "dockview-theme-band dockview-center-tabs",
};

// ---------------------------------------------------------------------------
// Per-workspace dockview api registry
// ---------------------------------------------------------------------------
//
// The shell (`SharedDockviewLayout`) owns global keyboard shortcuts + dialogs
// but no longer owns a dockview. It resolves the ACTIVE workspace's dockview
// api from this registry to route panel-activation / maximize / edge-toggle
// shortcuts. Registered on `onReady`, cleared on unmount.
// ---------------------------------------------------------------------------

const workspaceDockviewApis = new Map<string, DockviewApi>();

export function getWorkspaceDockviewApi(workspaceId: string | null): DockviewApi | undefined {
  return workspaceId ? workspaceDockviewApis.get(workspaceId) : undefined;
}

/** First panel of a given leaf kind (or the singleton), or undefined. */
export function firstLeafOfKind(api: DockviewApi, kind: LeafKind) {
  return api.panels.find((p) => (p.api.component as LeafKind) === kind);
}

// Per-workspace leaf actions, so the shell (SharedDockviewLayout) can add a
// leaf to the active workspace's dockview (e.g. ⇧⌘N new chat) without owning
// a dockview api. Registered on `onReady`, cleared on unmount.
const workspaceLeafActions = new Map<string, { current: LeafActions }>();

export function getWorkspaceLeafActions(workspaceId: string | null): LeafActions | undefined {
  return workspaceId ? workspaceLeafActions.get(workspaceId)?.current : undefined;
}

// Per-workspace monotonic counter for untitled scratch buffers, mirroring
// `useFileTabs`'s `untitledCounterRef` — the file leaf isn't backed by
// `useFileTabs` (dockview owns the tab list), so the shell mints the
// `untitled:N` path itself. In-memory only: a reload restarts at 1, which is
// acceptable since untitled buffers aren't persisted across reloads here.
const untitledCounters = new Map<string, number>();

/** Mint the next `untitled:N` path for a workspace (1-based, monotonic). */
export function nextUntitledPath(workspaceId: string): string {
  const n = (untitledCounters.get(workspaceId) ?? 0) + 1;
  untitledCounters.set(workspaceId, n);
  return `${UNTITLED_PREFIX}${n}`;
}

// ---------------------------------------------------------------------------
// Per-workspace layout persistence (localStorage)
// ---------------------------------------------------------------------------
//
// Bumped v8 → v9 for Phase 2: v8 layouts (written during Phase 1) held `files`
// / `changes` singleton panels whose component types no longer exist, so
// restoring one would render an unregistered component and crash. Clean break —
// stale v8 blobs are simply ignored and a default layout is rebuilt.

const LAYOUT_KEY_PREFIX = "band:dockview-layout-v9:";

// Leaf component names this dockview can actually render. A saved layout that
// references anything else (a removed kind, a hand-edited blob) is sanitized on
// load so `fromJSON` never instantiates a panel we can't mount.
const KNOWN_LEAF_COMPONENTS = new Set<string>(["chat", "term", "browser", "file", "diff"]);

function layoutKey(workspaceId: string): string {
  return `${LAYOUT_KEY_PREFIX}${workspaceId}`;
}

function isDockviewLayout(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.grid === "object" && typeof o.panels === "object";
}

/** Recursively strip a set of view ids from a dockview grid branch. */
function pruneGridViews(node: unknown, removed: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  const data = n.data as { views?: string[]; activeView?: string } | undefined;
  if (data && Array.isArray(data.views)) {
    data.views = data.views.filter((v) => !removed.has(v));
    if (data.activeView && removed.has(data.activeView)) data.activeView = data.views[0];
  }
  if (Array.isArray(n.children)) {
    for (const child of n.children) pruneGridViews(child, removed);
  }
}

/** Drop panels whose `component` isn't a renderable leaf kind (e.g. a stale
 *  `files`/`changes` singleton from an older layout) so `fromJSON` can't mount
 *  an unregistered component. Mutates + returns the layout clone. */
function sanitizeSavedLayout(layout: Record<string, unknown>): Record<string, unknown> {
  const panels = layout.panels as Record<string, { component?: string }> | undefined;
  if (!panels) return layout;
  const removed = new Set<string>();
  for (const [id, panel] of Object.entries(panels)) {
    if (!panel?.component || !KNOWN_LEAF_COMPONENTS.has(panel.component)) {
      removed.add(id);
      delete panels[id];
    }
  }
  if (removed.size > 0) {
    const grid = layout.grid as { root?: unknown } | undefined;
    if (grid?.root) pruneGridViews(grid.root, removed);
    if (typeof layout.activePanel === "string" && removed.has(layout.activePanel)) {
      layout.activePanel = undefined;
    }
  }
  return layout;
}

/** Serialize structure only — runtime params (callbacks, urls) are re-derived
 *  from each panel's `component` + `id` on load. */
function stripParams(json: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(json));
  const panels = clone.panels as Record<string, Record<string, unknown>> | undefined;
  if (panels) {
    for (const panel of Object.values(panels)) panel.params = {};
  }
  return clone;
}

/** Re-inject `{ workspaceId, <kind>Id }` (and browser `initialUrl`) into the
 *  saved layout's panel params before `fromJSON`. */
function reinjectParams(
  layout: Record<string, unknown>,
  workspaceId: string,
  urls: Map<string, string>,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(layout));
  const panels = clone.panels as Record<string, Record<string, unknown>> | undefined;
  if (panels) {
    for (const [id, panel] of Object.entries(panels)) {
      const comp = panel.component as LeafKind;
      if (comp === "chat") panel.params = { workspaceId, chatId: id };
      else if (comp === "term") panel.params = { workspaceId, terminalId: id };
      else if (comp === "browser")
        panel.params = { workspaceId, browserId: id, initialUrl: urls.get(id) };
      // `"file:".length === 5` and `"diff:".length === 5` — strip the prefix
      // back into the filePath param. Line/column are transient (jump targets)
      // and intentionally not persisted.
      else if (comp === "file") panel.params = { workspaceId, filePath: id.slice(5) };
      else if (comp === "diff") panel.params = { workspaceId, filePath: id.slice(5) };
      else panel.params = { workspaceId };
    }
  }
  return clone;
}

function loadSavedLayout(workspaceId: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(layoutKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isDockviewLayout(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared settings fetch
//
// `settings.get` is global. A workspace with several chat tabs would otherwise
// fire one `settings.get` per tab header mount (N small server-side file
// reads). A short-TTL shared promise collapses that burst into a single fetch
// while staying fresh enough that a Settings-UI agent change is picked up on
// the next tab mount. Ported from the legacy `DockviewChatContainer`.
// ---------------------------------------------------------------------------

let sharedSettingsPromise: Promise<unknown> | null = null;
let sharedSettingsAt = 0;
const SHARED_SETTINGS_TTL_MS = 5_000;

function getSharedSettings(): Promise<unknown> {
  const now = Date.now();
  if (!sharedSettingsPromise || now - sharedSettingsAt > SHARED_SETTINGS_TTL_MS) {
    sharedSettingsAt = now;
    sharedSettingsPromise = trpc.settings.get.query().catch(() => {
      // Don't cache a failed fetch for the whole TTL — reset so the next
      // mount retries instead of every tab in the window seeing null.
      sharedSettingsPromise = null;
      return null;
    });
  }
  return sharedSettingsPromise;
}

// ---------------------------------------------------------------------------
// Live-instance data (chats / terminals / browsers) fetched once per mount
// ---------------------------------------------------------------------------

interface CenterLayoutData {
  chatIds: Set<string>;
  terminalIds: Set<string>;
  browserIds: Set<string>;
  urls: Map<string, string>;
}

function centerLayoutKey(workspaceId: string) {
  return ["workspaceCenterLayout", workspaceId] as const;
}

// ---------------------------------------------------------------------------
// Leaf param shapes
// ---------------------------------------------------------------------------

interface ChatLeafParams {
  workspaceId: string;
  chatId: string;
}
interface TermLeafParams {
  workspaceId: string;
  terminalId: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  autoFocus?: boolean;
}
interface BrowserLeafParams {
  workspaceId: string;
  browserId: string;
  initialUrl?: string;
}
interface FileLeafParams {
  workspaceId: string;
  filePath: string;
  line?: number;
  column?: number;
  external?: boolean;
  /** Untitled scratch buffer (`untitled:N` path) — no backing file until saved. */
  untitled?: boolean;
  /** Preview (italic, reused) tab — set by a single-click, cleared on pin. */
  preview?: boolean;
}
interface DiffLeafParams {
  workspaceId: string;
  filePath: string;
  preview?: boolean;
}

// ---------------------------------------------------------------------------
// Chat leaf
// ---------------------------------------------------------------------------

function ChatLeaf({ params, api }: IDockviewPanelProps<ChatLeafParams>) {
  const [tabActive, setTabActive] = useState(api.isActive);
  const { visible: parentVisible, wsActive } = usePanelVisibility();

  useEffect(() => {
    const d = api.onDidActiveChange((e) => setTabActive(e.isActive));
    return () => d.dispose();
  }, [api]);

  if (!params.workspaceId || !params.chatId) return null;

  return (
    <ChatLeafContent
      workspaceId={params.workspaceId}
      chatId={params.chatId}
      visible={parentVisible && tabActive}
      wsActive={wsActive}
      setTitle={(title) => api.setTitle(title)}
    />
  );
}

function ChatLeafContent({
  workspaceId,
  chatId,
  visible,
  wsActive,
  setTitle,
}: {
  workspaceId: string;
  chatId: string;
  visible: boolean;
  wsActive: boolean;
  setTitle: (title: string) => void;
}) {
  const state = useChatPaneState(workspaceId, chatId);

  const setTitleRef = useRef(setTitle);
  setTitleRef.current = setTitle;
  useEffect(() => {
    if (!state.sessionQueryDone) return;
    const title = state.activeSessionSummary || state.agentLabel || state.codingAgentId || "Chat";
    setTitleRef.current(title);
  }, [state.sessionQueryDone, state.activeSessionSummary, state.agentLabel, state.codingAgentId]);

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`center-chat-leaf__visible-${visible ? "true" : "false"}`}
    >
      <ChatPane
        workspaceId={workspaceId}
        chatId={chatId}
        visible={visible}
        wsActive={wsActive}
        state={state}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal leaf
// ---------------------------------------------------------------------------

function TerminalLeaf({ params, api }: IDockviewPanelProps<TermLeafParams>) {
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
      data-testid={`center-term-leaf__visible-${visible ? "true" : "false"}`}
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
// Browser leaf (desktop only)
// ---------------------------------------------------------------------------

function BrowserLeaf({ params, api }: IDockviewPanelProps<BrowserLeafParams>) {
  const { visible } = usePanelVisibility();

  if (!params.workspaceId || !params.browserId) return null;

  const paneParams: BrowserPaneParams = {
    workspaceId: params.workspaceId,
    browserId: params.browserId,
    wsActive: visible,
    initialUrl: params.initialUrl,
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`center-browser-leaf__visible-${visible ? "true" : "false"}`}
    >
      <BrowserPaneComponent
        params={paneParams}
        api={api}
        // biome-ignore lint/suspicious/noExplicitAny: dockview panel props require matching shape
        {...({} as any)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// File + Diff per-path leaves (opened from the right sidepanel)
// ---------------------------------------------------------------------------

/** Last path segment (POSIX or Windows separators), for a tab title. */
function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

// ---------------------------------------------------------------------------
// Per-file editor-state persistence (localStorage) — FRESH reads/writes
// ---------------------------------------------------------------------------
//
// Format-compatible with mobile's `useTabState` (same `band-tab-state:<ws>`
// key + `TabFileState` shape). But `useTabState` caches its state in a
// per-instance `useRef` loaded once from localStorage, and dockview renders
// the tab header (`FileTab`) and the leaf content (`FileLeaf`) as SEPARATE
// React trees — so a `useTabState` instance in one is invisible to the other.
// These module-level helpers read/write localStorage FRESH on every call,
// sidestepping that cross-instance staleness while staying interoperable with
// mobile's store.
// ---------------------------------------------------------------------------

const TAB_STATE_KEY = (ws: string): string => `band-tab-state:${ws}`;

function readTabStates(ws: string): Record<string, TabFileState> {
  try {
    const raw = localStorage.getItem(TAB_STATE_KEY(ws));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, TabFileState>;
  } catch {
    return {};
  }
}

function writeTabStates(ws: string, states: Record<string, TabFileState>): void {
  try {
    localStorage.setItem(TAB_STATE_KEY(ws), JSON.stringify(states));
  } catch {
    // storage unavailable — best-effort
  }
}

function getFileTabState(ws: string, path: string): TabFileState | undefined {
  return readTabStates(ws)[path];
}

function updateFileTabState(ws: string, path: string, patch: Partial<TabFileState>): void {
  const states = readTabStates(ws);
  states[path] = { ...(states[path] ?? {}), ...patch };
  writeTabStates(ws, states);
}

function isFileDirty(ws: string, path: string): boolean {
  return getFileTabState(ws, path)?.editedContent != null;
}

function removeFileTabState(ws: string, path: string): void {
  const states = readTabStates(ws);
  if (path in states) {
    delete states[path];
    writeTabStates(ws, states);
  }
}

// ---------------------------------------------------------------------------
// Self-contained find-in-file for the file / diff leaves
// ---------------------------------------------------------------------------
//
// `FileViewer` has no built-in find, so we replicate the small slice of
// CodeBrowserView / DiffView's wiring here: a `useSearch` over the leaf's
// CodeMirror editor view(s) plus a `SearchBar`. `useSearch` already ships a
// window-level Cmd/Ctrl+F handler and reports its "open find" fn through
// `onFindInFile`, so all we add on top is:
//   - scoping open-on-⌘F to focus inside THIS leaf (capture-phase keydown on
//     the leaf container, mirroring the terminal/chat leaf handlers), and
//   - registering the leaf's open fn with the shell's per-workspace
//     `crossPanelHandlers.onFindInFile` registry while the leaf is visible so
//     the global ⌘F (SharedDockviewLayout) resolves to it.
function useLeafFind(workspaceId: string, visible: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The set of CodeMirror EditorViews to search. `file` leaves have one;
  // `diff` leaves have one (unified) or two (split) — kept untyped to avoid a
  // direct @codemirror/view dependency in this component (same pattern as
  // CodeBrowserView).
  // biome-ignore lint/suspicious/noExplicitAny: EditorView from @codemirror/view — kept untyped to avoid cross-package dependency
  const viewsRef = useRef<any[]>([]);
  const getViews = useCallback(() => viewsRef.current, []);

  // Only the visible leaf registers with the shell's per-workspace registry,
  // so the global ⌘F resolves to the leaf the user is looking at (the registry
  // holds a single fn per workspace). Hidden leaves pass `null` and unregister.
  const onFindInFile = useMemo(
    () =>
      visible
        ? (fn: (() => void) | null) => crossPanelHandlers.onFindInFile(workspaceId, fn)
        : null,
    [visible, workspaceId],
  );

  const search = useSearch({ getViews, onFindInFile });

  // Re-dispatch the active query to newly-registered views (e.g. a split-diff
  // second pane, or the editor after content loads).
  const setViews = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: EditorView from @codemirror/view — kept untyped
    (views: any[]) => {
      viewsRef.current = views;
      if (views.length > 0) search.dispatchToViews(views);
    },
    [search.dispatchToViews],
  );

  // Open on Cmd/Ctrl+F only when focus is inside this leaf. `useSearch`'s own
  // window handler is unscoped (it would open every mounted leaf's bar), so we
  // stop it here and drive just this leaf's open. Esc closes via the SearchBar.
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.shiftKey || e.key.toLowerCase() !== "f") return;
      if (!containerRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      search.handleOpenSearch();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, search.handleOpenSearch]);

  const searchBar = search.searchOpen ? (
    <SearchBar
      ref={search.searchBarRef}
      query={search.searchQuery}
      onQueryChange={search.setSearchQuery}
      options={search.searchOptions}
      onOptionsChange={search.setSearchOptions}
      placeholder="Find in file..."
      matchInfo={search.matchInfo}
      onNext={search.handleNext}
      onPrevious={search.handlePrevious}
      onClose={search.handleCloseSearch}
    />
  ) : undefined;

  return { containerRef, setViews, searchBar };
}

// ---------------------------------------------------------------------------
// Per-file LSP extension for the file leaf
// ---------------------------------------------------------------------------
//
// Mirrors CodeBrowserView's LSP wiring (createLspExtension on mount /
// path+language change, releaseLspClient on cleanup). External + untitled
// paths get no LSP (external files are outside the project root; untitled
// buffers have no file URI). `createLspExtension` / `releaseLspClient`
// refcount a shared client per WS url, so multiple file leaves open at once
// acquire/release safely — same guarantee CodeBrowserView relies on.

// Maps a file extension to the CodeMirror language name used by the LSP layer
// (identical table to CodeBrowserView's).
const LSP_EXT_LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mts: "typescript",
  cts: "typescript",
  mjs: "javascript",
  cjs: "javascript",
};

function fileCmLang(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext ? LSP_EXT_LANG_MAP[ext] : undefined;
}

function useFileLeafLsp(
  workspaceId: string,
  filePath: string,
  external: boolean,
): Extension | null {
  const { settings } = useSettingsQuery();
  const workspacePath = useWorkspacePath(workspaceId);
  const [lspExtension, setLspExtension] = useState<Extension | null>(null);

  // External / untitled files skip LSP entirely (no useful project context /
  // no file URI). Only TS/JS-family files have a mapped server language.
  const lspServerLang = useMemo(() => {
    if (!settings.enableLSP) return null;
    if (external || isUntitledPath(filePath)) return null;
    const cmLang = fileCmLang(filePath);
    return cmLang ? toLspServerLang(cmLang) : null;
  }, [filePath, external, settings.enableLSP]);

  const lspWsUrl = useMemo(
    () => (lspServerLang ? buildLspWsUrl(workspaceId, lspServerLang) : null),
    [workspaceId, lspServerLang],
  );

  useEffect(() => {
    if (!lspWsUrl || !workspacePath) {
      setLspExtension(null);
      return;
    }
    let cancelled = false;
    const rootUri = toFileUri(workspacePath);
    const documentUri = toFileUri(workspacePath, filePath);
    const cmLang = fileCmLang(filePath);
    const languageId = cmLang ? getLspLanguageId(cmLang) : undefined;
    createLspExtension(lspWsUrl, rootUri, documentUri, languageId, workspaceId)
      .then((ext) => {
        if (!cancelled) setLspExtension(ext);
      })
      .catch((err) => {
        console.warn("[FileLeaf] LSP extension creation failed:", err);
        if (!cancelled) setLspExtension(null);
      });
    return () => {
      cancelled = true;
    };
  }, [lspWsUrl, workspacePath, filePath, workspaceId]);

  // Release the shared client for the *previous* url on change / unmount.
  useEffect(() => {
    return () => {
      if (lspWsUrl) releaseLspClient(lspWsUrl);
    };
  }, [lspWsUrl]);

  return lspExtension;
}

// ---------------------------------------------------------------------------
// Active-file tracking (feeds the per-workspace `currentFile` store)
// ---------------------------------------------------------------------------
//
// Re-enables Quick Open's current-file highlight + the Explorer/Changes tree
// highlight, both of which subscribe to `currentFile`. A `file` / `diff` leaf
// publishes its path to the store only when it is BOTH the active tab in its
// group AND visible (`usePanelVisibility().visible` already folds in
// "outer panel visible AND workspace active"), so a hidden or cached
// workspace's leaves never clobber the active workspace's current file.
function useActiveFileTracking(
  api: IDockviewPanelProps["api"],
  workspaceId: string,
  filePath: string,
  visible: boolean,
): void {
  const [tabActive, setTabActive] = useState(api.isActive);
  useEffect(() => {
    const d = api.onDidActiveChange((e) => setTabActive(e.isActive));
    return () => d.dispose();
  }, [api]);

  useEffect(() => {
    if (!visible || !tabActive || !workspaceId || !filePath) return;
    setPerWorkspaceState(workspaceId, { currentFile: filePath });
  }, [visible, tabActive, workspaceId, filePath]);
}

function FileLeaf({ params, api }: IDockviewPanelProps<FileLeafParams>) {
  const { visible } = usePanelVisibility();
  const { containerRef, setViews, searchBar } = useLeafFind(params.workspaceId ?? "", visible);
  useActiveFileTracking(api, params.workspaceId ?? "", params.filePath ?? "", visible);
  const capabilities = useCapabilities();
  const workspaceIdRaw = params.workspaceId ?? "";
  const filePathRaw = params.filePath ?? "";
  const untitled = params.untitled === true || isUntitledPath(filePathRaw);
  const external = untitled ? false : (params.external ?? filePathRaw.startsWith("/"));
  const lspExtension = useFileLeafLsp(workspaceIdRaw, filePathRaw, external || untitled);

  const workspacePath = useWorkspacePath(workspaceIdRaw);

  const handleEditorView = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: EditorView from @codemirror/view — kept untyped
    (view: any) => setViews(view ? [view] : []),
    [setViews],
  );

  // Save-as flow for untitled buffers. `capabilities.pickSaveFile` bundles the
  // OS "Save As" dialog + the disk write and resolves with the absolute path
  // (null on cancel). On success we open the now-real file as its own leaf
  // (workspace-relative when it landed inside the workspace, external
  // otherwise) and close this untitled leaf — mirrors CodeBrowserView's
  // untitled→file transition, just at the leaf granularity.
  const pickSaveFile = capabilities.pickSaveFile;
  const handleSaveAs = useCallback(
    async (content: string): Promise<string | null> => {
      if (!pickSaveFile) return null;
      const chosen = await pickSaveFile({ content, defaultPath: workspacePath ?? undefined });
      if (!chosen) return null;
      const chosenPosix = chosen.replace(/\\/g, "/");
      const relative = workspacePath != null ? pathInside(workspacePath, chosenPosix) : null;
      const isExternal = relative === null;
      const newPath = relative ?? chosenPosix;
      const actions = getWorkspaceLeafActions(workspaceIdRaw);
      // Drop the untitled buffer's persisted edited-content so the close
      // confirm doesn't treat the (now-saved) tab as dirty, then swap leaves.
      removeFileTabState(workspaceIdRaw, filePathRaw);
      actions?.openFile(newPath, { external: isExternal, preview: false });
      actions?.onClose(`file:${filePathRaw}`, "file");
      window.dispatchEvent(new CustomEvent("band:dirty-change"));
      return chosenPosix;
    },
    [pickSaveFile, workspacePath, workspaceIdRaw, filePathRaw],
  );

  if (!params.workspaceId || !params.filePath) return null;
  const workspaceId = params.workspaceId;
  const filePath = params.filePath;
  const persisted = getFileTabState(workspaceId, filePath);
  return (
    <div
      ref={containerRef}
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`center-file-leaf__visible-${visible ? "true" : "false"}`}
    >
      <FileViewer
        workspaceId={workspaceId}
        filePath={filePath}
        line={params.line}
        column={params.column}
        editable
        external={external}
        untitled={untitled}
        // LSP is workspace-scoped: external files have no project root and
        // untitled buffers have no file URI, so `useFileLeafLsp` returns null
        // for both — pass it straight through.
        lspExtension={lspExtension}
        // Untitled buffers save through the OS "Save As" dialog; file-backed
        // tabs save in place (FileViewer handles that itself), so only wire
        // `onSaveAs` when this is an untitled buffer and the shell can save.
        onSaveAs={untitled && pickSaveFile ? handleSaveAs : undefined}
        // The dockview tab already shows the filename (full path on hover), so
        // hide only FileViewer's redundant path/size label — keep the title bar
        // and its action buttons (save, format, markdown code/preview toggle,
        // language). Nav arrows stay hidden (no onGoBack/onGoForward passed).
        hidePathLabel
        // Markdown files get a code/preview toggle in the title bar; the
        // preview reuses the shared MarkdownPreview renderer.
        renderMarkdown={(content) => <MarkdownPreview content={content} />}
        onEditorView={handleEditorView}
        toolbar={searchBar}
        // Editor-state persistence (localStorage, `band-tab-state:<ws>`). Seed
        // from the fresh module-level store and write back on every change so a
        // reload restores unsaved edits, the markdown code/preview choice, and
        // the manual language override. The dirty CustomEvent lets the tab
        // header (a separate React tree) re-check its dirty dot.
        //
        // Cursor/scroll `editorState` persistence is DEFERRED: FileViewer
        // exposes no `onEditorStateChange`-style callback to capture it, and we
        // deliberately don't fabricate one here.
        initialEditedContent={persisted?.editedContent ?? null}
        onEditedContentChange={(content) => {
          updateFileTabState(workspaceId, filePath, {
            editedContent: content ?? undefined,
          });
          window.dispatchEvent(new CustomEvent("band:dirty-change"));
        }}
        viewMode={persisted?.viewMode}
        onViewModeChange={(mode) => updateFileTabState(workspaceId, filePath, { viewMode: mode })}
        languageOverride={persisted?.language}
        onLanguageOverrideChange={(languageId) =>
          updateFileTabState(workspaceId, filePath, { language: languageId })
        }
      />
    </div>
  );
}

// Full-file context: `getFileDiff`'s max contextLines renders the whole file
// with the changes in place (not just the changed hunks) — matches DiffView's
// "Show full file" step.
const FULL_FILE_CONTEXT = 99999;

function DiffLeaf({ params, api, containerApi }: IDockviewPanelProps<DiffLeafParams>) {
  // On desktop the diff selection tooltip offers only "Copy reference"; the
  // "Add to Chat" / "Add to Terminal" routing actions are reserved for the
  // mobile diff tooltip (#643). Mobile leaves are tagged in `mobileByApiId`.
  const isMobile = mobileByApiId.has(containerApi.id);
  const { visible } = usePanelVisibility();
  const { workspaceId, filePath } = params;
  const adapter = useAdapter();
  const { containerRef, setViews, searchBar } = useLeafFind(workspaceId ?? "", visible);
  useActiveFileTracking(api, workspaceId ?? "", filePath ?? "", visible);
  const { diffMode, compareBranch } = useDiffTarget(workspaceId ?? "");
  const [viewMode, setViewMode] = useState<ViewMode>(() => getStoredViewMode());
  const [revertOpen, setRevertOpen] = useState(false);

  const setMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    storeViewMode(mode);
  }, []);

  const summaryQuery = useQuery({
    queryKey: ["diffLeafSummary", workspaceId, diffMode, compareBranch],
    queryFn: () =>
      trpc.workspace.getDiffSummary.query({
        workspaceId,
        diffMode,
        compareBranch: compareBranch ?? undefined,
      }),
    enabled: !!workspaceId && !!filePath,
    // Keep an open diff reasonably fresh while it's the visible leaf, mirroring
    // the sidepanel's visibility-gated poll — a hidden/cached leaf never polls.
    refetchInterval: visible ? 10_000 : false,
  });

  const mergeBase = summaryQuery.data?.mergeBase;

  const fileDiffQuery = useQuery({
    queryKey: ["diffLeafFile", workspaceId, filePath, mergeBase],
    queryFn: () =>
      trpc.workspace.getFileDiff.query({
        workspaceId,
        filePath,
        mergeBase: mergeBase ?? "",
        // Show the full file, with the diff in place — clicking a changed file
        // opens its whole contents, not just the changed hunks.
        contextLines: FULL_FILE_CONTEXT,
      }),
    enabled: !!workspaceId && !!filePath && !!mergeBase,
    refetchInterval: visible ? 10_000 : false,
  });

  if (!workspaceId || !filePath) return null;

  const diff = fileDiffQuery.data?.diff;
  const loading = summaryQuery.isLoading || fileDiffQuery.isLoading;

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`center-diff-leaf__visible-${visible ? "true" : "false"}`}
    >
      {/* Header: open-for-editing (left) + split/unified toggle (right). The
          toggle shares the `band:diff-view-mode` preference with DiffView. */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-1 border-b border-border px-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              getWorkspaceLeafActions(workspaceId)?.openFile(filePath, { preview: false })
            }
            title="Open file for editing"
            data-testid="center-diff-leaf__open-file"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <SquarePen className="size-3.5" />
            Edit
          </button>
          {adapter.revertFile && (
            <button
              type="button"
              onClick={() => setRevertOpen(true)}
              title="Revert file"
              data-testid="center-diff-leaf__revert"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RotateCcw className="size-3.5" />
              Revert
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setMode("unified")}
            aria-pressed={viewMode === "unified"}
            title="Unified view"
            data-testid="center-diff-leaf__view--unified"
            className={`inline-flex size-6 items-center justify-center rounded transition-colors hover:bg-accent ${
              viewMode === "unified" ? "bg-accent text-foreground" : "text-muted-foreground"
            }`}
          >
            <AlignJustify className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setMode("split")}
            aria-pressed={viewMode === "split"}
            title="Side-by-side view"
            data-testid="center-diff-leaf__view--split"
            className={`inline-flex size-6 items-center justify-center rounded transition-colors hover:bg-accent ${
              viewMode === "split" ? "bg-accent text-foreground" : "text-muted-foreground"
            }`}
          >
            <Columns2 className="size-3.5" />
          </button>
        </div>
      </div>
      {searchBar}
      <div className="min-h-0 flex-1 overflow-auto">
        {diff ? (
          <DiffFileContent
            hunks={diff}
            filename={filePath}
            viewMode={viewMode}
            onEditorViews={setViews}
            copyReferenceOnly={!isMobile}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
            {loading ? "Loading diff…" : "No changes"}
          </div>
        )}
      </div>

      <Dialog open={revertOpen} onOpenChange={setRevertOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revert file</DialogTitle>
            <DialogDescription>
              Discard all changes to <span className="font-mono">{basename(filePath)}</span>? This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevertOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void adapter.revertFile
                  ?.call(adapter, workspaceId, filePath, diffMode, compareBranch ?? undefined)
                  .then(() => {
                    setRevertOpen(false);
                    fileDiffQuery.refetch();
                    summaryQuery.refetch();
                  })
                  .catch((err) => console.error("[DiffLeaf] revert failed:", err));
              }}
            >
              Revert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-instance action registry (stable dockview header/tab components)
// ---------------------------------------------------------------------------
//
// dockview's header + tab components must be STABLE references, but the
// handlers they invoke are per-workspace (each mounted WorkspaceCenterDockview
// has its own api). MultiWorkspacePanelHost keeps several workspaces mounted
// at once, so a module-level singleton would suffer last-writer-wins. Key the
// handlers by the owning dockview's `api.id` (dockview passes `containerApi`
// into the props), reading the latest closures via the ref holder.
// ---------------------------------------------------------------------------

interface LeafActions {
  onAdd: (kind: LeafKind, groupId?: string) => void;
  onSplit: (kind: LeafKind, groupId: string, direction: "right" | "below") => void;
  onClose: (id: string, kind: LeafKind) => void;
  openFile: (
    filePath: string,
    opts?: {
      line?: number;
      column?: number;
      external?: boolean;
      preview?: boolean;
      untitled?: boolean;
    },
  ) => void;
  openDiff: (filePath: string, opts?: { preview?: boolean }) => void;
}

const leafActionsByApiId = new Map<string, { current: LeafActions }>();

// Mobile flag keyed by the owning dockview's `api.id`. Header action components
// must be STABLE references (dockview caches them), so they can't read a
// per-instance `mobile` prop directly — they look it up here by
// `containerApi.id`. Set on `onReady`, cleared on unmount. Desktop dockviews
// never add themselves, so `has(id)` is false → maximize toggle stays.
const mobileByApiId = new Set<string>();

// ---------------------------------------------------------------------------
// Tab headers
// ---------------------------------------------------------------------------

function IconTab(props: IDockviewPanelHeaderProps) {
  const component = props.api.component;
  const Icon = PANEL_ICONS[component];
  const shortcut = PANEL_SHORTCUTS[component];
  const [title, setTitle] = useState(props.api.title ?? "");
  const [badge, setBadge] = useState<number | undefined>(props.params?.badge as number | undefined);

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? ""));
    return () => d.dispose();
  }, [props.api]);

  useEffect(() => {
    const d = props.api.onDidParametersChange(() => {
      setBadge(props.api.getParameters<{ badge?: number }>().badge);
    });
    return () => d.dispose();
  }, [props.api]);

  const hasBadge = badge != null && badge > 0;

  const tab = (
    <div className={TAB_ROOT_CLASS} data-testid={`center-tab--${component}`}>
      {Icon ? (
        <Icon className="size-4 shrink-0" />
      ) : (
        <span className="inline-block size-4 shrink-0" aria-hidden />
      )}
      <span className={TAB_TITLE_CLASS}>{title}</span>
      {hasBadge && (
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/20 px-1.5 text-xs font-medium text-blue-600 dark:text-blue-400">
          {badge}
        </span>
      )}
    </div>
  );

  if (!shortcut) return tab;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{tab}</TooltipTrigger>
      <TooltipContent>
        {title} ({shortcut})
      </TooltipContent>
    </Tooltip>
  );
}

/** Coding-agent types whose CLI can resume a session in a terminal. */
const RESUME_CAPABLE_AGENT_TYPES = new Set(["claude-code", "codex", "opencode"]);

function readCachedTabMeta(chatId: string): { title?: string; agentType?: string } {
  if (!chatId) return {};
  try {
    const raw = sessionStorage.getItem(`band:chat-tab-meta:${chatId}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCachedTabMeta(chatId: string, patch: { title?: string; agentType?: string }) {
  if (!chatId) return;
  try {
    const prev = readCachedTabMeta(chatId);
    sessionStorage.setItem(`band:chat-tab-meta:${chatId}`, JSON.stringify({ ...prev, ...patch }));
  } catch {}
}

function ChatTab(props: IDockviewPanelHeaderProps<ChatLeafParams>) {
  const chatId = props.params.chatId;
  const workspaceId = props.params.workspaceId;
  const initialCache = readCachedTabMeta(chatId);
  const [title, setTitle] = useState(initialCache.title ?? props.api.title ?? "Chat");
  const [agentType, setAgentType] = useState<string | undefined>(initialCache.agentType);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const isActive = useTabActive(props.api);

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => {
      const next = props.api.title ?? "Chat";
      setTitle(next);
      writeCachedTabMeta(chatId, { title: next });
    });
    return () => d.dispose();
  }, [props.api, chatId]);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const codingAgentsRef = useRef<CodingAgentDef[]>([]);
  const defaultAgentIdRef = useRef<string | undefined>(undefined);

  const applyChatMeta = useCallback(
    (chat: { agent?: string; activeSessionId?: string } | null | undefined) => {
      if (!mountedRef.current) return;
      setSessionId(chat?.activeSessionId ?? undefined);
      const agentId = chat?.agent ?? defaultAgentIdRef.current ?? "";
      const found = codingAgentsRef.current.find((a) => a.id === agentId);
      if (found) {
        setAgentType(found.type);
        writeCachedTabMeta(chatId, { agentType: found.type });
      }
    },
    [chatId],
  );

  const refreshTabMeta = useCallback(() => {
    if (!chatId || !workspaceId) return;
    Promise.all([
      getSharedSettings(),
      trpc.chats.get.query({ chatId }).catch(() => ({ chat: null })),
    ])
      .then(([settings, chatResult]) => {
        if (!mountedRef.current) return;
        const raw = (settings as Record<string, unknown> | null)?.codingAgents;
        codingAgentsRef.current = Array.isArray(raw) ? (raw as CodingAgentDef[]) : [];
        defaultAgentIdRef.current = (settings as Record<string, unknown> | null)
          ?.defaultCodingAgent as string | undefined;
        applyChatMeta(chatResult.chat);
      })
      .catch(() => {});
  }, [chatId, workspaceId, applyChatMeta]);

  const refreshChatMeta = useCallback(() => {
    if (!chatId) return;
    trpc.chats.get
      .query({ chatId })
      .then((res) => applyChatMeta(res.chat))
      .catch(() => {});
  }, [chatId, applyChatMeta]);

  useEffect(() => {
    refreshTabMeta();
  }, [refreshTabMeta]);

  const canResume = !!sessionId && !!agentType && RESUME_CAPABLE_AGENT_TYPES.has(agentType);

  const handleContinueInTerminal = useCallback(() => {
    trpc.chats.continueInTerminal
      .mutate({ chatId })
      .then(() => crossPanelHandlers.onActivateTerminalPanel(workspaceId))
      .catch((err) => console.error("[ChatTab] continue in terminal failed:", err));
  }, [chatId, workspaceId]);

  const handleCopySessionId = useCallback(() => {
    if (!sessionId) return;
    void writeClipboardText(sessionId);
  }, [sessionId]);

  const containerApi = props.containerApi;
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      leafActionsByApiId.get(containerApi.id)?.current?.onClose(chatId, "chat");
    },
    [containerApi, chatId],
  );

  return (
    <ContextMenu onOpenChange={(open) => open && refreshChatMeta()}>
      <ContextMenuTrigger asChild>
        <div className={TAB_ROOT_CLASS} data-testid={`center-chat-tab--${chatId}`}>
          <div className={TAB_CONTENT_WRAP}>
            <span
              className="inline-flex size-3.5 shrink-0 items-center justify-center transition-opacity duration-150"
              style={{ opacity: agentType ? 1 : 0 }}
            >
              {agentType && <AgentIcon type={agentType} className="size-3.5" />}
            </span>
            <span className={TAB_TITLE_CLASS} title={title}>
              {title}
            </span>
          </div>
          <button
            type="button"
            className={closeButtonClass(isActive)}
            onClick={handleClose}
            title="Close tab"
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="center-chat-tab__context-menu">
        <ContextMenuItem
          disabled={!canResume}
          onClick={handleContinueInTerminal}
          data-testid="center-chat-tab__context-menu-item--continue-in-terminal"
        >
          Continue in terminal
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!sessionId}
          onClick={handleCopySessionId}
          data-testid="center-chat-tab__context-menu-item--copy-session-id"
        >
          Copy session ID
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TerminalTab(props: IDockviewPanelHeaderProps<TermLeafParams>) {
  const [title, setTitle] = useState(props.api.title ?? "Terminal");
  const terminalId = props.params.terminalId;
  const containerApi = props.containerApi;
  const isActive = useTabActive(props.api);

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? "Terminal"));
    return () => d.dispose();
  }, [props.api]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      leafActionsByApiId.get(containerApi.id)?.current?.onClose(terminalId, "term");
    },
    [containerApi, terminalId],
  );

  const handleCopyTerminalId = useCallback(() => {
    void writeClipboardText(terminalId);
  }, [terminalId]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={TAB_ROOT_CLASS} data-testid={`center-term-tab--${terminalId}`}>
          <div className={TAB_CONTENT_WRAP}>
            <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={TAB_TITLE_CLASS} title={title}>
              {title}
            </span>
          </div>
          <button
            type="button"
            className={closeButtonClass(isActive)}
            onClick={handleClose}
            title="Close terminal"
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="center-term-tab__context-menu">
        <ContextMenuItem
          onClick={handleCopyTerminalId}
          data-testid="center-term-tab__context-menu-item--copy-terminal-id"
        >
          <ClipboardCopy className="size-4" />
          Copy terminal ID
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function BrowserTab(props: IDockviewPanelHeaderProps<BrowserLeafParams>) {
  const [title, setTitle] = useState(props.api.title ?? "New Tab");
  const [faviconError, setFaviconError] = useState(false);
  const browserId = props.params.browserId;
  const containerApi = props.containerApi;
  const isActive = useTabActive(props.api);
  const faviconUrl = useFavicon(browserId);
  const prevFaviconRef = useRef(faviconUrl);

  if (faviconUrl !== prevFaviconRef.current) {
    prevFaviconRef.current = faviconUrl;
    if (faviconError) setFaviconError(false);
  }

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? "New Tab"));
    return () => d.dispose();
  }, [props.api]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      leafActionsByApiId.get(containerApi.id)?.current?.onClose(browserId, "browser");
    },
    [containerApi, browserId],
  );

  const showFavicon = faviconUrl && !faviconError;

  return (
    <div className={TAB_ROOT_CLASS} data-testid={`center-browser-tab--${browserId}`}>
      <div className={TAB_CONTENT_WRAP}>
        {showFavicon ? (
          <img
            src={faviconUrl}
            alt=""
            className="size-3.5 shrink-0"
            onError={() => setFaviconError(true)}
          />
        ) : (
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className={TAB_TITLE_CLASS} title={title}>
          {title}
        </span>
      </div>
      <button
        type="button"
        className={closeButtonClass(isActive)}
        onClick={handleClose}
        title="Close tab"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** Right-click menu on a file/diff tab: copy the workspace-relative or absolute
 *  path. `absolute` needs the workspace root (from `useWorkspacePath`); it's
 *  disabled until that resolves, or when the path is already absolute (external
 *  file), in which case relative == absolute == the path itself. */
function TabPathContextMenu({
  workspaceId,
  filePath,
  testidPrefix,
  children,
}: {
  workspaceId: string;
  filePath: string;
  testidPrefix: string;
  children: React.ReactNode;
}) {
  const workspacePath = useWorkspacePath(workspaceId);
  const isAbsolute = filePath.startsWith("/");
  const absolute = isAbsolute
    ? filePath
    : workspacePath
      ? `${workspacePath.replace(/\/+$/, "")}/${filePath}`
      : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid={`${testidPrefix}__context-menu`}>
        <ContextMenuItem
          onClick={() => void writeClipboardText(filePath)}
          data-testid={`${testidPrefix}__context-menu-item--copy-relative-path`}
        >
          <ClipboardCopy className="size-4" />
          Copy relative path
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!absolute}
          onClick={() => absolute && void writeClipboardText(absolute)}
          data-testid={`${testidPrefix}__context-menu-item--copy-absolute-path`}
        >
          <ClipboardCopy className="size-4" />
          Copy absolute path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FileTab(props: IDockviewPanelHeaderProps<FileLeafParams>) {
  const { workspaceId, filePath } = props.params;
  const containerApi = props.containerApi;
  const isActive = useTabActive(props.api);
  const isPreview = useTabPreview(props.api);
  const title = basename(filePath);

  // Dirty indicator. `FileLeaf` (a separate dockview React tree) dispatches
  // `band:dirty-change` on every edited-content change; re-read the fresh
  // per-file store when that fires. Seeded synchronously so a restored dirty
  // file shows the dot immediately on mount.
  const [dirty, setDirty] = useState(() => isFileDirty(workspaceId, filePath));
  useEffect(() => {
    const recheck = () => setDirty(isFileDirty(workspaceId, filePath));
    window.addEventListener("band:dirty-change", recheck);
    return () => window.removeEventListener("band:dirty-change", recheck);
  }, [workspaceId, filePath]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      leafActionsByApiId.get(containerApi.id)?.current?.onClose(`file:${filePath}`, "file");
    },
    [containerApi, filePath],
  );

  return (
    <TabPathContextMenu
      workspaceId={workspaceId}
      filePath={filePath}
      testidPrefix={`center-file-tab--${filePath}`}
    >
      <div className={TAB_ROOT_CLASS} data-testid={`center-file-tab--${filePath}`}>
        <div className={TAB_CONTENT_WRAP}>
          <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={`${TAB_TITLE_CLASS}${isPreview ? " italic" : ""}`} title={filePath}>
            {title}
          </span>
        </div>
        {/* VS Code-style close slot. When the file is dirty and the tab is NOT
            active, render a filled dot in the same slot as the close X: the dot
            is visible at rest and fades out on hover (`group-hover:opacity-0`),
            while the X (via `closeButtonClass` on an inactive tab:
            `opacity-0 group-hover:opacity-100`) fades in on hover — so they
            swap cleanly. On the active tab the X is always shown (opacity-70),
            so the dot is suppressed entirely to avoid overlapping the X. */}
        {dirty && !isActive ? (
          <span
            aria-hidden
            data-testid={`center-file-tab__dirty--${filePath}`}
            className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center opacity-100 transition-opacity group-hover:opacity-0"
          >
            <span className="size-2 rounded-full bg-foreground/70" />
          </span>
        ) : null}
        <button
          type="button"
          className={closeButtonClass(isActive)}
          onClick={handleClose}
          title="Close file"
        >
          <X className="size-3" />
        </button>
      </div>
    </TabPathContextMenu>
  );
}

function DiffTab(props: IDockviewPanelHeaderProps<DiffLeafParams>) {
  const { workspaceId, filePath } = props.params;
  const containerApi = props.containerApi;
  const isActive = useTabActive(props.api);
  const isPreview = useTabPreview(props.api);
  const title = basename(filePath);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      leafActionsByApiId.get(containerApi.id)?.current?.onClose(`diff:${filePath}`, "diff");
    },
    [containerApi, filePath],
  );

  return (
    <TabPathContextMenu
      workspaceId={workspaceId}
      filePath={filePath}
      testidPrefix={`center-diff-tab--${filePath}`}
    >
      <div className={TAB_ROOT_CLASS} data-testid={`center-diff-tab--${filePath}`}>
        <div className={TAB_CONTENT_WRAP}>
          <GitCompare className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={`${TAB_TITLE_CLASS}${isPreview ? " italic" : ""}`} title={filePath}>
            {title}
          </span>
        </div>
        <button
          type="button"
          className={closeButtonClass(isActive)}
          onClick={handleClose}
          title="Close diff"
        >
          <X className="size-3" />
        </button>
      </div>
    </TabPathContextMenu>
  );
}

// ---------------------------------------------------------------------------
// Header actions: the "+" new-tab menu renders in the LEFT slot (right after
// the last tab, browser-style); the maximize toggle stays in the RIGHT slot.
// ---------------------------------------------------------------------------

const LeftHeaderActions = memo(function LeftHeaderActions(props: IDockviewHeaderActionsProps) {
  return (
    <div className="flex h-full items-center px-0.5">
      <NewTabMenu apiId={props.containerApi.id} groupId={props.group.id} />
    </div>
  );
});

const RightHeaderActions = memo(function RightHeaderActions(props: IDockviewHeaderActionsProps) {
  const isGridGroup = (props.location?.type ?? "grid") === "grid";

  const [isMaximized, setIsMaximized] = useState(() => props.api.isMaximized());
  useEffect(() => {
    const refresh = () => setIsMaximized(props.api.isMaximized());
    refresh();
    const d = props.containerApi.onDidMaximizedGroupChange(refresh);
    return () => d.dispose();
  }, [props.api, props.containerApi]);

  // Edge groups don't maximize — the add menu (left slot) is enough there.
  if (!isGridGroup) return null;

  // Mobile / tabs-only mode: no maximize toggle (the layout is a single
  // full-screen group; there's nothing to maximize against).
  if (mobileByApiId.has(props.containerApi.id)) return null;

  const MaxIcon = isMaximized ? Minimize2 : Maximize2;
  const maxLabel = isMaximized ? "Restore" : "Maximize";

  return (
    <div className="flex h-full items-center px-1" data-testid="workspace-center__toolbar">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={maxLabel}
            onClick={(e) => {
              if (props.api.isMaximized()) {
                prepareMaximizeRestoreAnimation(e.currentTarget.closest<HTMLElement>(".dv-shell"));
                props.api.exitMaximized();
              } else {
                props.api.maximize();
              }
            }}
            className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <MaxIcon className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {maxLabel}
          <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
            ⇧⌘M
          </kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  );
});

function NewTabMenu({ apiId, groupId }: { apiId: string; groupId: string }) {
  const add = (kind: LeafKind) => leafActionsByApiId.get(apiId)?.current?.onAdd(kind, groupId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="New tab"
          className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          data-testid="workspace-center__new-tab-button"
        >
          <Plus className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="workspace-center__new-tab-menu">
        <DropdownMenuItem onClick={() => add("term")} data-testid="workspace-center__new-tab--term">
          <TerminalIcon className="size-4" />
          New Terminal
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => add("chat")} data-testid="workspace-center__new-tab--chat">
          <MessageSquare className="size-4" />
          New Chat
        </DropdownMenuItem>
        {isDesktop && (
          <DropdownMenuItem
            onClick={() => add("browser")}
            data-testid="workspace-center__new-tab--browser"
          >
            <Globe className="size-4" />
            New Browser
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Component registries
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: dockview requires generic panel props
const components: Record<string, React.FunctionComponent<IDockviewPanelProps<any>>> = {
  chat: ChatLeaf,
  term: TerminalLeaf,
  browser: BrowserLeaf,
  file: FileLeaf,
  diff: DiffLeaf,
};

const tabComponents: Record<string, React.FunctionComponent<IDockviewPanelHeaderProps>> = {
  chat: ChatTab,
  term: TerminalTab,
  browser: BrowserTab,
  file: FileTab,
  diff: DiffTab,
  icon: IconTab,
};

// ---------------------------------------------------------------------------
// addPanel helpers
// ---------------------------------------------------------------------------

type AddPanelOptions = Parameters<DockviewApi["addPanel"]>[0];

function addChatLeaf(
  api: DockviewApi,
  workspaceId: string,
  chatId: string,
  position?: AddPanelOptions["position"],
): void {
  api.addPanel({
    id: chatId,
    component: "chat",
    tabComponent: "chat",
    title: "Chat",
    params: { workspaceId, chatId },
    position: position ?? centralPanelPosition(api),
  } as AddPanelOptions);
}

function addTermLeaf(
  api: DockviewApi,
  workspaceId: string,
  terminalId: string,
  extra?: Partial<TermLeafParams>,
  position?: AddPanelOptions["position"],
): void {
  api.addPanel({
    id: terminalId,
    component: "term",
    tabComponent: "term",
    title: "Terminal",
    params: { workspaceId, terminalId, ...extra },
    position: position ?? centralPanelPosition(api),
  } as AddPanelOptions);
}

function addBrowserLeaf(
  api: DockviewApi,
  workspaceId: string,
  browserId: string,
  initialUrl?: string,
  position?: AddPanelOptions["position"],
): void {
  api.addPanel({
    id: browserId,
    component: "browser",
    tabComponent: "browser",
    title: "New Tab",
    params: { workspaceId, browserId, ...(initialUrl ? { initialUrl } : {}) },
    position: position ?? centralPanelPosition(api),
  } as AddPanelOptions);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface WorkspaceCenterDockviewProps {
  workspaceId: string;
  visible: boolean;
  wsActive: boolean;
  /** Mobile / tabs-only mode: disables drag→split (`disableDnd`) and hides the
   *  maximize toggle in the right header actions. Everything else (leaves,
   *  tabs, close, dirty dot, find, preview, `+` New-tab menu) is unchanged.
   *  Defaults to false (desktop behaviour). */
  mobile?: boolean;
}

export function WorkspaceCenterDockview({
  workspaceId,
  visible,
  wsActive,
  mobile = false,
}: WorkspaceCenterDockviewProps) {
  const adapter = useAdapter();
  const apiRef = useRef<DockviewApi | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isRestoringRef = useRef(false);
  const wsActiveRef = useRef(wsActive);
  wsActiveRef.current = wsActive;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const edgeDragDisposerRef = useRef<(() => void) | null>(null);
  const innerRegisterDisposerRef = useRef<(() => void) | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // VS Code-style preview tabs: at most one previewing file leaf and one
  // previewing diff leaf per dockview. A single-click in the sidepanel opens
  // a leaf in "preview" mode (italic tab) that the NEXT single-click reuses
  // (closes + replaces); a double-click — or editing — pins it. These refs
  // hold the id of the current preview leaf of each kind, or null.
  const previewFileIdRef = useRef<string | null>(null);
  const previewDiffIdRef = useRef<string | null>(null);

  // Close-confirm for a dirty file leaf: holds the pending {id, path} while the
  // "Unsaved changes" dialog is open, or null when no confirm is in flight.
  const [pendingClose, setPendingClose] = useState<{ id: string; path: string } | null>(null);

  const { data: initialData } = useQuery<CenterLayoutData>({
    queryKey: centerLayoutKey(workspaceId),
    queryFn: async () => {
      const [chatsRes, terminalsRes, browsersRes] = await Promise.all([
        trpc.chats.list.query({ workspaceId }).catch(() => ({ chats: [] as { id: string }[] })),
        trpc.terminal.list
          .query({ workspaceId })
          .catch(() => ({ terminals: [] as { terminalId: string }[] })),
        isDesktop
          ? trpc.browsers.list
              .query({ workspaceId })
              .catch(() => ({ browsers: [] as { id: string; url?: string }[] }))
          : Promise.resolve({ browsers: [] as { id: string; url?: string }[] }),
      ]);
      const urls = new Map<string, string>();
      for (const b of browsersRes.browsers) {
        if (b.url && b.url !== "about:blank") urls.set(b.id, b.url);
      }
      return {
        chatIds: new Set(chatsRes.chats.map((c) => c.id)),
        terminalIds: new Set(terminalsRes.terminals.map((t) => t.terminalId)),
        browserIds: new Set(browsersRes.browsers.map((b) => b.id)),
        urls,
      };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const initialDataRef = useRef<CenterLayoutData | null>(null);
  initialDataRef.current = initialData ?? null;

  // ---- persistence ----
  // Write the current layout to localStorage now.
  const writeLayout = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const json = stripParams(api.toJSON() as unknown as Record<string, unknown>);
      localStorage.setItem(layoutKey(workspaceId), JSON.stringify(json));
    } catch {
      // best-effort
    }
  }, [workspaceId]);

  // Debounced save — used for the high-frequency `onDidLayoutChange` (drag /
  // resize / move) so we don't write on every pixel.
  const schedulePersist = useCallback(() => {
    if (isRestoringRef.current || !apiRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      writeLayout();
    }, 400);
  }, [writeLayout]);

  // Immediate save — used for discrete STRUCTURAL changes (add / close a leaf,
  // add / remove a group). Closing a tab must persist right away: a debounced
  // write can be lost to a fast reload, an unmount, or a continuous stream of
  // layout events resetting the timer. Cancels any pending debounce first.
  const flushPersist = useCallback(() => {
    if (isRestoringRef.current || !apiRef.current) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    writeLayout();
  }, [writeLayout]);

  const reportFocus = useCallback(() => {
    if (isRestoringRef.current || wsActiveRef.current === false) return;
    const panel = apiRef.current?.activePanel;
    if (!panel) return;
    const kind = panel.api.component as LeafKind;
    const panelType =
      kind === "chat"
        ? "chat"
        : kind === "term"
          ? "terminal"
          : kind === "browser"
            ? "browser"
            : null;
    if (!panelType) return;
    trpc.panelFocus.set.mutate({ workspaceId, panelType, panelId: panel.id }).catch(() => {});
  }, [workspaceId]);

  // ---- add / split / close ----
  const handleAdd = useCallback(
    (kind: LeafKind, groupId?: string) => {
      const api = apiRef.current;
      if (!api) return;
      const position = groupId ? { referenceGroup: groupId } : undefined;
      if (kind === "term") {
        const id = newTerminalId();
        addTermLeaf(api, workspaceId, id, { autoFocus: true }, position);
        trpc.terminal.create.mutate({ workspaceId, id }).catch((err) => {
          console.error("[WorkspaceCenterDockview] terminal create failed:", err);
        });
      } else if (kind === "chat") {
        const id = newChatId();
        markChatFresh(id);
        addChatLeaf(api, workspaceId, id, position);
      } else if (kind === "browser") {
        if (!isDesktop) return;
        const id = newBrowserId();
        markBrowserFresh(id);
        addBrowserLeaf(api, workspaceId, id, undefined, position);
        trpc.browsers.create.mutate({ workspaceId, id }).catch((err) => {
          console.error("[WorkspaceCenterDockview] browser create failed:", err);
        });
      }
    },
    [workspaceId],
  );

  const handleSplit = useCallback(
    (kind: LeafKind, groupId: string, direction: "right" | "below") => {
      const api = apiRef.current;
      if (!api) return;
      const position = { referenceGroup: groupId, direction };
      if (kind === "term") {
        const id = newTerminalId();
        addTermLeaf(api, workspaceId, id, { autoFocus: true }, position);
        trpc.terminal.create.mutate({ workspaceId, id }).catch(() => {});
      } else if (kind === "chat") {
        const id = newChatId();
        markChatFresh(id);
        addChatLeaf(api, workspaceId, id, position);
      } else if (kind === "browser" && isDesktop) {
        const id = newBrowserId();
        markBrowserFresh(id);
        addBrowserLeaf(api, workspaceId, id, undefined, position);
        trpc.browsers.create.mutate({ workspaceId, id }).catch(() => {});
      }
    },
    [workspaceId],
  );

  // Actually remove a leaf (panel + any server-side instance). Shared by the
  // normal close path and the "Close without saving" confirm button. For a
  // `file` leaf, also drop its persisted editor state so the next open starts
  // clean (mirrors mobile's `removeFile` on tab close).
  const doCloseLeaf = useCallback(
    (id: string, kind: LeafKind) => {
      const api = apiRef.current;
      if (!api) return;
      selectNeighbourBeforeRemove(api, id);
      const panel = api.getPanel(id);
      if (panel) api.removePanel(panel);
      if (kind === "term") {
        disposeTerminal(id);
        trpc.terminal.kill.mutate({ terminalId: id }).catch(() => {});
      } else if (kind === "chat") {
        trpc.chats.remove.mutate({ chatId: id }).catch(() => {});
      } else if (kind === "browser") {
        trpc.browsers.remove.mutate({ browserId: id }).catch(() => {});
      } else if (kind === "file") {
        removeFileTabState(workspaceId, id.slice(5));
      }
      // file / diff leaves are otherwise pure client views — no server mutation.
    },
    [workspaceId],
  );

  const handleClose = useCallback(
    (id: string, kind: LeafKind) => {
      const api = apiRef.current;
      if (!api) return;
      // Never close the last remaining tab — the workspace center must always
      // hold at least one leaf (an empty dockview has no tab strip to reopen from).
      if (api.panels.length <= 1) return;
      // Closing a dirty file prompts first; the confirm button does the removal.
      if (kind === "file") {
        const path = id.slice(5); // strip the `file:` prefix
        if (isFileDirty(workspaceId, path)) {
          setPendingClose({ id, path });
          return;
        }
      }
      doCloseLeaf(id, kind);
    },
    [workspaceId, doCloseLeaf],
  );

  // ---- open a per-path file / diff leaf (driven by the right sidepanel) ----
  const handleOpenFile = useCallback(
    (
      filePath: string,
      opts?: {
        line?: number;
        column?: number;
        external?: boolean;
        preview?: boolean;
        untitled?: boolean;
      },
    ) => {
      const api = apiRef.current;
      if (!api) return;
      const preview = opts?.preview ?? false;
      const id = `file:${filePath}`;
      const existing = api.getPanel(id);
      if (existing) {
        // Pinning (double-click / intentional open) an already-open preview
        // clears its preview flag so the next single-click won't replace it.
        if (!preview && previewFileIdRef.current === id) previewFileIdRef.current = null;
        // Spread current params so we never drop workspaceId/filePath/external
        // regardless of dockview's updateParameters merge semantics.
        const cur = existing.api.getParameters<FileLeafParams>();
        existing.api.updateParameters({
          ...cur,
          line: opts?.line,
          column: opts?.column,
          preview: preview ? cur.preview : false,
        });
        existing.api.setActive();
        return;
      }
      // Opening a NEW preview replaces the current preview leaf (close the old
      // one) so previews reuse a single slot.
      if (preview && previewFileIdRef.current && previewFileIdRef.current !== id) {
        const prev = api.getPanel(previewFileIdRef.current);
        if (prev) api.removePanel(prev);
      }
      api.addPanel({
        id,
        component: "file",
        tabComponent: "file",
        title: basename(filePath),
        params: {
          workspaceId,
          filePath,
          line: opts?.line,
          column: opts?.column,
          external: opts?.external,
          untitled: opts?.untitled,
          preview,
        },
        position: centralPanelPosition(api),
      } as AddPanelOptions);
      previewFileIdRef.current = preview ? id : previewFileIdRef.current;
    },
    [workspaceId],
  );

  const handleOpenDiff = useCallback(
    (filePath: string, opts?: { preview?: boolean }) => {
      const api = apiRef.current;
      if (!api) return;
      const preview = opts?.preview ?? false;
      const id = `diff:${filePath}`;
      const existing = api.getPanel(id);
      if (existing) {
        if (!preview && previewDiffIdRef.current === id) previewDiffIdRef.current = null;
        if (!preview) {
          const cur = existing.api.getParameters<DiffLeafParams>();
          existing.api.updateParameters({ ...cur, preview: false });
        }
        existing.api.setActive();
        return;
      }
      if (preview && previewDiffIdRef.current && previewDiffIdRef.current !== id) {
        const prev = api.getPanel(previewDiffIdRef.current);
        if (prev) api.removePanel(prev);
      }
      api.addPanel({
        id,
        component: "diff",
        tabComponent: "diff",
        title: basename(filePath),
        params: { workspaceId, filePath, preview },
        position: centralPanelPosition(api),
      } as AddPanelOptions);
      previewDiffIdRef.current = preview ? id : previewDiffIdRef.current;
    },
    [workspaceId],
  );

  const actionsRef = useRef<LeafActions>({
    onAdd: () => {},
    onSplit: () => {},
    onClose: () => {},
    openFile: () => {},
    openDiff: () => {},
  });
  actionsRef.current = {
    onAdd: handleAdd,
    onSplit: handleSplit,
    onClose: handleClose,
    openFile: handleOpenFile,
    openDiff: handleOpenDiff,
  };

  // ---- default layout ----
  const buildDefaultLayout = useCallback(
    (api: DockviewApi, data: CenterLayoutData) => {
      // Chats on the left.
      const chatIds = data.chatIds.size ? [...data.chatIds] : [newChatId()];
      if (!data.chatIds.size) markChatFresh(chatIds[0]);
      let anchorId: string | null = null;
      for (const chatId of chatIds) {
        addChatLeaf(
          api,
          workspaceId,
          chatId,
          anchorId ? { referencePanel: anchorId, direction: "within" } : undefined,
        );
        if (!anchorId) anchorId = chatId;
      }

      // Right group anchored to the first chat: terminals, then browsers all
      // stacked into the same group. `rightGroupAnchor` tracks the id of the
      // first panel placed in that group so every later leaf lands `within` it.
      let rightGroupAnchor: string | null = null;
      const rightPosition = (): AddPanelOptions["position"] =>
        rightGroupAnchor
          ? { referencePanel: rightGroupAnchor, direction: "within" }
          : ({
              referencePanel: anchorId ?? undefined,
              direction: "right",
            } as AddPanelOptions["position"]);

      const termIds = [...data.terminalIds];
      if (termIds.length === 0) {
        const id = newTerminalId();
        addTermLeaf(api, workspaceId, id, undefined, rightPosition());
        rightGroupAnchor = id;
        trpc.terminal.create.mutate({ workspaceId, id }).catch(() => {});
      } else {
        for (const id of termIds) {
          addTermLeaf(api, workspaceId, id, undefined, rightPosition());
          rightGroupAnchor ??= id;
        }
      }

      if (isDesktop) {
        for (const id of [...data.browserIds]) {
          addBrowserLeaf(api, workspaceId, id, data.urls.get(id), rightPosition());
          rightGroupAnchor ??= id;
        }
      }

      try {
        api.getPanel(chatIds[0])?.api.setActive();
        api.getPanel(chatIds[0])?.api.setSize({ width: api.width * 0.5 });
      } catch {}
    },
    [workspaceId],
  );

  // ---- reconcile a restored layout against live instances ----
  const reconcile = useCallback(
    (api: DockviewApi, data: CenterLayoutData) => {
      // Remove per-instance leaves whose server record is gone.
      for (const panel of [...api.panels]) {
        const kind = panel.api.component as LeafKind;
        if (kind === "chat" && !data.chatIds.has(panel.id)) api.removePanel(panel);
        else if (kind === "term" && !data.terminalIds.has(panel.id)) api.removePanel(panel);
        else if (kind === "browser" && !data.browserIds.has(panel.id)) api.removePanel(panel);
      }
      // Add live instances missing from the restored layout (CLI-created while closed).
      for (const chatId of data.chatIds) {
        if (!api.getPanel(chatId)) addChatLeaf(api, workspaceId, chatId);
      }
      for (const terminalId of data.terminalIds) {
        if (!api.getPanel(terminalId)) addTermLeaf(api, workspaceId, terminalId);
      }
      if (isDesktop) {
        for (const browserId of data.browserIds) {
          if (!api.getPanel(browserId))
            addBrowserLeaf(api, workspaceId, browserId, data.urls.get(browserId));
        }
      }
      // Restored `file` / `diff` leaves are pure client views with no server
      // record — leave them exactly as they were persisted (do NOT prune).
      // Guarantee at least one chat leaf survives — if every chat was pruned
      // (all server records gone), the workspace would otherwise show only the
      // restored file/diff leaves (or nothing). Mirrors the legacy all-orphaned
      // fallback.
      if (!api.panels.some((p) => (p.api.component as LeafKind) === "chat")) {
        const chatId = newChatId();
        markChatFresh(chatId);
        addChatLeaf(api, workspaceId, chatId);
      }
    },
    [workspaceId],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      workspaceDockviewApis.set(workspaceId, api);
      workspaceLeafActions.set(workspaceId, actionsRef);
      leafActionsByApiId.set(api.id, actionsRef);
      if (mobile) mobileByApiId.add(api.id);

      const data = initialDataRef.current ?? {
        chatIds: new Set<string>(),
        terminalIds: new Set<string>(),
        browserIds: new Set<string>(),
        urls: new Map<string, string>(),
      };

      isRestoringRef.current = true;
      const saved = loadSavedLayout(workspaceId);
      if (saved) {
        try {
          api.fromJSON(
            // biome-ignore lint/suspicious/noExplicitAny: dockview fromJSON requires any
            reinjectParams(sanitizeSavedLayout(saved), workspaceId, data.urls) as any,
          );
          reconcile(api, data);
        } catch (err) {
          console.error("[WorkspaceCenterDockview] fromJSON failed, rebuilding:", err);
          for (const p of [...api.panels]) api.removePanel(p);
          buildDefaultLayout(api, data);
        }
      } else {
        buildDefaultLayout(api, data);
      }

      // Edge groups + drag visibility + shortcut registry.
      ensureEdgeGroups(api);
      edgeDragDisposerRef.current?.();
      edgeDragDisposerRef.current = attachEdgeGroupDragVisibility(api);
      innerRegisterDisposerRef.current?.();
      if (containerRef.current) {
        innerRegisterDisposerRef.current = registerInnerDockview(containerRef.current, api);
      }

      // Persistence + focus reporting. Structural changes (add/remove leaf or
      // group) flush immediately so a close survives an instant reload; the
      // high-frequency layout stream (resize/move) is debounced.
      api.onDidLayoutChange(() => schedulePersist());
      api.onDidAddPanel(() => flushPersist());
      api.onDidRemovePanel((panel) => {
        // Drop the preview pointer if the previewing leaf was closed, so a
        // later single-click opens fresh instead of trying to reuse a dead id.
        if (previewFileIdRef.current === panel.id) previewFileIdRef.current = null;
        if (previewDiffIdRef.current === panel.id) previewDiffIdRef.current = null;
        flushPersist();
      });
      api.onDidAddGroup(() => flushPersist());
      api.onDidRemoveGroup(() => flushPersist());
      api.onDidActivePanelChange(() => {
        schedulePersist();
        reportFocus();
      });

      setTimeout(() => {
        isRestoringRef.current = false;
      }, 0);

      // Cold-mount layout catch-up.
      if (visibleRef.current && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          api.layout(Math.round(rect.width), Math.round(rect.height), true);
        }
      }
    },
    [
      workspaceId,
      mobile,
      buildDefaultLayout,
      reconcile,
      schedulePersist,
      flushPersist,
      reportFocus,
    ],
  );

  // Live sync: add/remove leaves when instances are created/killed externally (CLI).
  useEffect(() => {
    return adapter.subscribeStatusEvents((event) => {
      if (event.workspaceId !== workspaceId) return;
      const api = apiRef.current;
      if (!api) return;

      if (event.kind === "chat-created" && typeof event.chatId === "string") {
        if (!api.getPanel(event.chatId)) addChatLeaf(api, workspaceId, event.chatId);
      } else if (event.kind === "chat-removed" && typeof event.chatId === "string") {
        const panel = api.getPanel(event.chatId);
        if (panel) api.removePanel(panel);
      } else if (event.kind === "terminal-created" && typeof event.terminalId === "string") {
        if (!api.getPanel(event.terminalId)) addTermLeaf(api, workspaceId, event.terminalId);
      } else if (event.kind === "terminal-killed" && typeof event.terminalId === "string") {
        disposeTerminal(event.terminalId);
        const panel = api.getPanel(event.terminalId);
        if (panel) api.removePanel(panel);
      } else if (
        isDesktop &&
        event.kind === "browser-created" &&
        typeof event.browserId === "string"
      ) {
        if (!api.getPanel(event.browserId)) addBrowserLeaf(api, workspaceId, event.browserId);
      } else if (event.kind === "browser-removed" && typeof event.browserId === "string") {
        const panel = api.getPanel(event.browserId);
        if (panel) api.removePanel(panel);
      }
    });
  }, [adapter, workspaceId]);

  // Bring a specific chat/terminal leaf forward when "Add to Chat/Terminal" targets it.
  useEffect(() => {
    const onChatInsert = (e: Event) => {
      const detail = (e as CustomEvent<ChatInsertDetail>).detail;
      if (!detail?.chatId || detail.workspaceId !== workspaceId) return;
      apiRef.current?.getPanel(detail.chatId)?.api.setActive();
    };
    const onTerminalInsert = (e: Event) => {
      const detail = (e as CustomEvent<TerminalInsertDetail>).detail;
      if (!detail?.terminalId || detail.workspaceId !== workspaceId) return;
      apiRef.current?.getPanel(detail.terminalId)?.api.setActive();
    };
    window.addEventListener("band:chat-insert", onChatInsert);
    window.addEventListener("band:terminal-insert", onTerminalInsert);
    return () => {
      window.removeEventListener("band:chat-insert", onChatInsert);
      window.removeEventListener("band:terminal-insert", onTerminalInsert);
    };
  }, [workspaceId]);

  // Section-scoped keyboard shortcuts (active workspace + focus inside only).
  useEffect(() => {
    if (!visible) return;

    const refocusActive = () => {
      const panel = apiRef.current?.activePanel;
      if (!panel) return;
      const el = panel.view.content.element;
      (
        el.querySelector<HTMLElement>(".xterm-helper-textarea") ??
        el.querySelector<HTMLElement>("[data-band-address-input]")
      )?.focus();
    };

    const activeKind = (): LeafKind => {
      const comp = apiRef.current?.activePanel?.api.component as LeafKind | undefined;
      // ⌘T duplicates the active leaf's kind — but `file` / `diff` leaves are
      // opened per-path from the sidepanel, not created blank, so fall back to
      // a new terminal for those.
      return comp === "chat" || comp === "term" || comp === "browser" ? comp : "term";
    };

    const handler = (e: KeyboardEvent) => {
      if (!containerRef.current?.contains(document.activeElement)) return;
      const api = apiRef.current;
      if (!api) return;
      const key = e.key.toLowerCase();

      if (e.ctrlKey && !e.metaKey && key === "tab") {
        e.preventDefault();
        e.stopPropagation();
        cycleTabsInActiveGroup(api, e.shiftKey ? -1 : 1, () =>
          requestAnimationFrame(refocusActive),
        );
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.shiftKey && (key === "[" || key === "]")) {
        e.preventDefault();
        e.stopPropagation();
        cycleTabsInActiveGroup(api, key === "]" ? 1 : -1, () =>
          requestAnimationFrame(refocusActive),
        );
        return;
      }
      if (!e.shiftKey && (key === "[" || key === "]")) {
        e.preventDefault();
        e.stopPropagation();
        cycleGridGroups(api, key === "]" ? 1 : -1, () => requestAnimationFrame(refocusActive));
        return;
      }

      if (key === "t" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        handleAdd(activeKind(), api.activeGroup?.id);
      } else if (key === "w" && !e.shiftKey) {
        const active = api.activePanel;
        const kind = active?.api.component as LeafKind | undefined;
        if (!active || !kind) return;
        e.preventDefault();
        e.stopPropagation();
        handleClose(active.id, kind);
      } else if (key === "d") {
        const active = api.activePanel;
        const groupId = api.activeGroup?.id;
        const kind = active?.api.component as LeafKind | undefined;
        if (e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          if (groupId && (kind === "chat" || kind === "term" || kind === "browser")) {
            handleSplit(kind, groupId, e.shiftKey ? "below" : "right");
          }
        } else if (e.ctrlKey && !e.metaKey && !e.shiftKey) {
          // Ctrl+D closes a terminal (only when there's more than one to close).
          if (
            active &&
            kind === "term" &&
            api.panels.filter((p) => p.api.component === "term").length > 1
          ) {
            e.preventDefault();
            e.stopPropagation();
            handleClose(active.id, "term");
          }
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, handleAdd, handleClose, handleSplit]);

  // Focus the active leaf when the workspace becomes visible.
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      const panel = apiRef.current?.activePanel;
      if (!panel) return;
      const el = panel.view.content.element;
      (
        el.querySelector<HTMLElement>(".xterm-helper-textarea") ??
        el.querySelector<HTMLElement>("[data-band-address-input]")
      )?.focus();
      reportFocus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, reportFocus]);

  // Force a synchronous re-layout when this workspace's dockview becomes visible
  // (mirrors the legacy inner containers' reveal fix).
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
      if (w <= 0 || h <= 0 || (w === lastWidth && h === lastHeight)) return;
      lastWidth = w;
      lastHeight = h;
      api.layout(w, h, true);
    };
    const rect = container.getBoundingClientRect();
    applyLayout(rect.width, rect.height);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) applyLayout(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [visible]);

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      const api = apiRef.current;
      if (api) {
        leafActionsByApiId.delete(api.id);
        mobileByApiId.delete(api.id);
        if (workspaceDockviewApis.get(workspaceId) === api) {
          workspaceDockviewApis.delete(workspaceId);
          workspaceLeafActions.delete(workspaceId);
        }
      }
      edgeDragDisposerRef.current?.();
      edgeDragDisposerRef.current = null;
      innerRegisterDisposerRef.current?.();
      innerRegisterDisposerRef.current = null;
      // Flush a pending debounced save rather than dropping it, so a layout
      // tweak right before a workspace switch / unmount still persists.
      if (saveTimerRef.current && api) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        try {
          localStorage.setItem(
            layoutKey(workspaceId),
            JSON.stringify(stripParams(api.toJSON() as unknown as Record<string, unknown>)),
          );
        } catch {
          // best-effort
        }
      }
    };
  }, [workspaceId]);

  const visibilityValue = useMemo(
    () => ({ visible: visible && wsActive !== false, wsActive: wsActive !== false }),
    [visible, wsActive],
  );

  if (!initialData) {
    return <div className="flex h-full w-full items-center justify-center" />;
  }

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col overflow-hidden">
      <PanelVisibilityContext.Provider value={visibilityValue}>
        <DockviewReact
          theme={bandTheme}
          className="h-full"
          components={components}
          tabComponents={tabComponents}
          defaultTabComponent={IconTab}
          leftHeaderActionsComponent={LeftHeaderActions}
          rightHeaderActionsComponent={RightHeaderActions}
          // Mobile: no drag→split. Every leaf stays a tab in a single group.
          disableDnd={mobile}
          onReady={onReady}
        />
      </PanelVisibilityContext.Provider>

      {/* Unsaved-changes confirm for a dirty file leaf. Mirrors the mobile
          FileTabBar confirm: Cancel keeps the tab, "Close without saving"
          removes the panel and drops the persisted edited content (via
          `doCloseLeaf` → `removeFileTabState`). */}
      <Dialog open={pendingClose !== null} onOpenChange={(open) => !open && setPendingClose(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              {pendingClose ? basename(pendingClose.path) : ""} has unsaved changes. Close without
              saving?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingClose(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingClose) doCloseLeaf(pendingClose.id, "file");
                setPendingClose(null);
              }}
            >
              Close without saving
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
