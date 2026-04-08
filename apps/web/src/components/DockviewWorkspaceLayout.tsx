import {
  type DiffStats,
  DiffView,
  QuickOpenDialog,
  SearchFilesDialog,
} from "@band-app/dashboard-core";
import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";
import { FolderOpen, GitCompare, MessageSquare, Terminal as TerminalIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc-client";
import { CodeBrowserView } from "./CodeBrowserView";
import { WorkspaceChatPanel } from "./WorkspaceChatPanel";

// ---------------------------------------------------------------------------
// Custom dockview theme – prevents the default themeAbyss from being applied
// ---------------------------------------------------------------------------

const bandTheme: DockviewTheme = {
  name: "band",
  className: "dockview-theme-band",
};

// ---------------------------------------------------------------------------
// Panel icon map
// ---------------------------------------------------------------------------

const PANEL_ICONS: Record<string, React.FC<{ className?: string }>> = {
  chat: MessageSquare,
  changes: GitCompare,
  files: FolderOpen,
  terminal: TerminalIcon,
};

const PANEL_SHORTCUTS: Record<string, string> = {
  changes: "⌘E",
  files: "⌘G",
  terminal: "⌘J",
};

// ---------------------------------------------------------------------------
// Lazy-loaded terminal (avoid importing @xterm CJS during SSR)
// ---------------------------------------------------------------------------

const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

// ---------------------------------------------------------------------------
// Panel params types
// ---------------------------------------------------------------------------

interface ChatParams {
  workspaceId: string;
}

interface ChangesParams {
  workspaceId: string;
  onStatsChange: (stats: DiffStats | null) => void;
  onOpenFile: (filename: string) => void;
  onFindInFile: (fn: (() => void) | null) => void;
}

interface FilesParams {
  workspaceId: string;
  file: string | undefined;
  openFilePath: string | null;
  onSelectFile: (filePath: string | null) => void;
  onFileOpened: () => void;
  onFindInFile: (fn: (() => void) | null) => void;
}

interface TerminalParams {
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Panel wrapper components
// ---------------------------------------------------------------------------

function ChatPanelComponent({ params, api }: IDockviewPanelProps<ChatParams>) {
  const [visible, setVisible] = useState(api.isActive);

  useEffect(() => {
    const d1 = api.onDidActiveChange((e) => setVisible(e.isActive));
    const d2 = api.onDidVisibilityChange((e) => {
      if (e.isVisible && api.isActive) setVisible(true);
    });
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [api]);

  return <WorkspaceChatPanel workspaceId={params.workspaceId} visible={visible} />;
}

function ChangesPanelComponent({ params }: IDockviewPanelProps<ChangesParams>) {
  return (
    <DiffView
      workspaceId={params.workspaceId}
      active
      onStatsChange={params.onStatsChange}
      onOpenFile={params.onOpenFile}
      onFindInFile={params.onFindInFile}
    />
  );
}

function FilesPanelComponent({ params }: IDockviewPanelProps<FilesParams>) {
  return (
    <CodeBrowserView
      workspaceId={params.workspaceId}
      file={params.file}
      onSelectFile={params.onSelectFile}
      openFilePath={params.openFilePath}
      onFileOpened={params.onFileOpened}
      onFindInFile={params.onFindInFile}
    />
  );
}

function TerminalPanelComponent({ params, api }: IDockviewPanelProps<TerminalParams>) {
  const [visible, setVisible] = useState(api.isActive);

  useEffect(() => {
    const d1 = api.onDidActiveChange((e) => setVisible(e.isActive));
    const d2 = api.onDidVisibilityChange((e) => {
      if (e.isVisible && api.isActive) setVisible(true);
    });
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [api]);

  return (
    <Suspense fallback={null}>
      <TerminalPanel workspaceId={params.workspaceId} visible={visible} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Tab components (icon + title, no close button)
// ---------------------------------------------------------------------------

function DefaultTab(props: IDockviewPanelHeaderProps) {
  const Icon = PANEL_ICONS[props.api.component];
  const shortcut = PANEL_SHORTCUTS[props.api.component];
  const [title, setTitle] = useState(props.api.title ?? "");

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? ""));
    return () => d.dispose();
  }, [props.api]);

  const tab = (
    <div className="dv-default-tab">
      <div
        className="dv-default-tab-content"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        {Icon && <Icon className="size-4 shrink-0" />}
        <span>{title}</span>
      </div>
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

function BadgeTab(props: IDockviewPanelHeaderProps) {
  const Icon = PANEL_ICONS[props.api.component];
  const shortcut = PANEL_SHORTCUTS[props.api.component];
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

  const tab = (
    <div className="dv-default-tab">
      <div
        className="dv-default-tab-content"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        {Icon && <Icon className="size-4 shrink-0" />}
        <span>{title}</span>
        {badge != null && badge > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500/20 px-1.5 text-xs font-medium text-blue-600 dark:text-blue-400">
            {badge}
          </span>
        )}
      </div>
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

// ---------------------------------------------------------------------------
// Component and tab registries
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: dockview requires generic panel props
const components: Record<string, React.FunctionComponent<IDockviewPanelProps<any>>> = {
  chat: ChatPanelComponent,
  changes: ChangesPanelComponent,
  files: FilesPanelComponent,
  terminal: TerminalPanelComponent,
};

const tabComponents: Record<string, React.FunctionComponent<IDockviewPanelHeaderProps>> = {
  badge: BadgeTab,
};

// ---------------------------------------------------------------------------
// Diff file count hook (polls every 15s)
// ---------------------------------------------------------------------------

function useDiffFileCount(workspaceId: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fetchCount = () => {
      trpc.workspace.getDiffSummary
        .query({ workspaceId })
        .then((result) => {
          if (!cancelled) setCount(result.stats?.filesChanged ?? 0);
        })
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspaceId]);
  return count;
}

// ---------------------------------------------------------------------------
// Required panel definitions & layout persistence
// ---------------------------------------------------------------------------

/** All panels that must always be present in the layout. */
const REQUIRED_PANEL_IDS = ["chat", "changes", "files", "terminal"] as const;

const LAYOUT_KEY = "band:dockview-layout";

function saveLayout(api: DockviewApi) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
  } catch {}
}

function loadLayout(): unknown | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main DockviewWorkspaceLayout
// ---------------------------------------------------------------------------

interface DockviewWorkspaceLayoutProps {
  workspaceId: string;
  encodedId: string;
}

export function DockviewWorkspaceLayout({ workspaceId }: DockviewWorkspaceLayoutProps) {
  const apiRef = useRef<DockviewApi | null>(null);

  // Cross-panel state
  const [currentFile, setCurrentFile] = useState<string | undefined>(undefined);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const diffFileCount = useDiffFileCount(workspaceId);

  // Dialog state
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [searchFilesOpen, setSearchFilesOpen] = useState(false);

  // Find-in-file: active panel registers its search callback here
  const findInFileRef = useRef<(() => void) | null>(null);
  const setFindInFile = useCallback((fn: (() => void) | null) => {
    findInFileRef.current = fn;
  }, []);

  // Diff stats (not displayed directly, but tracked for badge)
  const setDiffStats = useCallback((_stats: DiffStats | null) => {
    // Stats are used via the polling-based diffFileCount instead
  }, []);

  // Open file from Changes panel or dialogs → activate Files panel
  const handleOpenFile = useCallback((filename: string) => {
    setCurrentFile(filename);
    setOpenFilePath(filename);
    const api = apiRef.current;
    if (api) {
      api.getPanel("files")?.api.setActive();
    }
  }, []);

  const handleFileOpened = useCallback(() => {
    setOpenFilePath(null);
  }, []);

  const handleSelectFile = useCallback((filePath: string | null) => {
    setCurrentFile(filePath ?? undefined);
  }, []);

  // Update Changes tab badge when diff file count changes
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const panel = api.getPanel("changes");
    if (panel) {
      panel.api.updateParameters({ badge: diffFileCount });
    }
  }, [diffFileCount]);

  // Update Files panel params when file state changes
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.getPanel("files")?.api.updateParameters({
      file: currentFile,
      openFilePath,
    });
  }, [currentFile, openFilePath]);

  // Global keyboard shortcuts (capture phase)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Shift+Tab → toggle mode (Edit/Plan)
      if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("band:toggle-mode"));
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const api = apiRef.current;
      const key = e.key.toLowerCase();

      if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpenOpen(true);
      } else if (key === "f" && e.shiftKey) {
        e.preventDefault();
        setSearchFilesOpen(true);
      } else if (key === "f" && !e.shiftKey) {
        e.preventDefault();
        if (findInFileRef.current) {
          findInFileRef.current();
        } else {
          window.dispatchEvent(new CustomEvent("band:find-in-file"));
        }
      } else if (key === "e" && !e.shiftKey && api) {
        e.preventDefault();
        api.getPanel("changes")?.api.setActive();
      } else if (key === "j" && !e.shiftKey && api) {
        e.preventDefault();
        api.getPanel("terminal")?.api.setActive();
      } else if (key === "g" && !e.shiftKey && api) {
        e.preventDefault();
        api.getPanel("files")?.api.setActive();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Wire callbacks into panels after layout restore (functions cannot be serialized)
  const injectParams = useCallback(
    (api: DockviewApi) => {
      api.getPanel("chat")?.api.updateParameters({
        workspaceId,
      });
      api.getPanel("changes")?.api.updateParameters({
        workspaceId,
        onStatsChange: setDiffStats,
        onOpenFile: handleOpenFile,
        onFindInFile: setFindInFile,
        badge: diffFileCount,
      });
      api.getPanel("files")?.api.updateParameters({
        workspaceId,
        file: currentFile,
        openFilePath,
        onSelectFile: handleSelectFile,
        onFileOpened: handleFileOpened,
        onFindInFile: setFindInFile,
      });
      api.getPanel("terminal")?.api.updateParameters({
        workspaceId,
      });
    },
    [
      workspaceId,
      currentFile,
      openFilePath,
      diffFileCount,
      setDiffStats,
      handleOpenFile,
      handleFileOpened,
      handleSelectFile,
      setFindInFile,
    ],
  );

  // Add a single missing panel back into the layout at a sensible position
  const addMissingPanel = useCallback(
    (api: DockviewApi, panelId: string) => {
      // Find any existing panel to anchor the new one relative to
      const anyExisting =
        api.getPanel("changes") ??
        api.getPanel("files") ??
        api.getPanel("terminal") ??
        api.getPanel("chat");

      const titleMap: Record<string, string> = {
        chat: "Chat",
        changes: "Changes",
        files: "Files",
        terminal: "Terminal",
      };

      const opts: Record<string, unknown> = {
        id: panelId,
        component: panelId,
        title: titleMap[panelId] ?? panelId,
        params: { workspaceId },
        inactive: true,
      };

      if (panelId === "changes") {
        opts.tabComponent = "badge";
      }

      // Place chat to the left; everything else as a tab alongside an existing panel
      if (panelId === "chat" && anyExisting) {
        opts.position = { referencePanel: anyExisting.id, direction: "left" };
      } else if (anyExisting) {
        opts.position = { referencePanel: anyExisting.id, direction: "within" };
      }

      // biome-ignore lint/suspicious/noExplicitAny: dynamic panel options
      api.addPanel(opts as any);
    },
    [workspaceId],
  );

  // Build the default layout from scratch
  const buildDefaultLayout = useCallback(
    (api: DockviewApi) => {
      api.addPanel({
        id: "chat",
        component: "chat",
        title: "Chat",
        params: { workspaceId },
      });

      api.addPanel({
        id: "changes",
        component: "changes",
        tabComponent: "badge",
        title: "Changes",
        params: { workspaceId },
        position: { referencePanel: "chat", direction: "right" },
      });

      api.addPanel({
        id: "files",
        component: "files",
        title: "Files",
        params: { workspaceId },
        position: { referencePanel: "changes", direction: "within" },
        inactive: true,
      });

      api.addPanel({
        id: "terminal",
        component: "terminal",
        title: "Terminal",
        params: { workspaceId },
        position: { referencePanel: "changes", direction: "within" },
        inactive: true,
      });

      // Set chat panel to ~50% width
      try {
        api.getPanel("chat")?.api.setSize({ width: api.width * 0.5 });
      } catch {}
    },
    [workspaceId],
  );

  // onReady: restore or create default layout, then heal missing panels
  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      // Try to restore a saved layout
      let restored = false;
      const saved = loadLayout();
      if (saved) {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: localStorage JSON shape
          event.api.fromJSON(saved as any);
          restored = true;
        } catch {
          // Corrupted layout — fall through to default
        }
      }

      if (!restored) {
        buildDefaultLayout(event.api);
      }

      // Self-heal: re-add any panels that are missing from the restored layout
      for (const id of REQUIRED_PANEL_IDS) {
        if (!event.api.getPanel(id)) {
          addMissingPanel(event.api, id);
        }
      }

      // After restore, inject live callback references
      // (setTimeout ensures fromJSON completes rendering)
      setTimeout(() => injectParams(event.api), 0);

      // Guard: if a required panel is removed (edge-case drag, API call, etc.)
      // re-add it immediately so it can't be lost
      const removeGuard = event.api.onDidRemovePanel((panel) => {
        const id = panel.id;
        if ((REQUIRED_PANEL_IDS as readonly string[]).includes(id)) {
          // Re-add on next tick so dockview finishes its removal first
          setTimeout(() => {
            if (!event.api.getPanel(id)) {
              addMissingPanel(event.api, id);
              injectParams(event.api);
            }
          }, 0);
        }
      });

      // Persist layout on changes
      const layoutChange = event.api.onDidLayoutChange(() => {
        saveLayout(event.api);
      });

      return () => {
        removeGuard.dispose();
        layoutChange.dispose();
      };
    },
    [buildDefaultLayout, addMissingPanel, injectParams],
  );

  // Re-inject params when callbacks/state change
  useEffect(() => {
    const api = apiRef.current;
    if (api) injectParams(api);
  }, [injectParams]);

  return (
    <>
      <DockviewReact
        key={workspaceId}
        theme={bandTheme}
        className="h-full"
        components={components}
        tabComponents={tabComponents}
        defaultTabComponent={DefaultTab}
        onReady={onReady}
      />

      <QuickOpenDialog
        workspaceId={workspaceId}
        open={quickOpenOpen}
        onOpenChange={setQuickOpenOpen}
        onOpenFile={handleOpenFile}
      />
      <SearchFilesDialog
        workspaceId={workspaceId}
        open={searchFilesOpen}
        onOpenChange={setSearchFilesOpen}
        onOpenFile={handleOpenFile}
      />
    </>
  );
}
