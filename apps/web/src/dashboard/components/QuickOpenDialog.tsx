import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { FileInput } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdapter, useCapabilities } from "../context";
import { getFileIcon } from "../lib/file-icon";
import { formatFileLocation, parseFileLocation } from "../lib/file-location";

interface QuickOpenDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string) => void;
  /** The currently open file path (used for ":line" go-to-line shortcut). */
  currentFile?: string;
  /** When set, the dialog opens with this query pre-filled. Cleared on close. */
  initialQuery?: string;
  /** When true and only one result is found, auto-open it without showing
   *  the dialog. The dialog is still shown if there are 0 or 2+ results. */
  autoOpen?: boolean;
  /** Recently accessed files, shown when the search query is empty. */
  recentFiles?: string[];
  /** The last search query, restored when the dialog opens (lower priority than initialQuery). */
  lastQuery?: string;
  /** Called on close with the current query so the parent can persist it. */
  onQueryChange?: (query: string) => void;
}

export function QuickOpenDialog({
  workspaceId,
  open,
  onOpenChange,
  onOpenFile,
  currentFile,
  initialQuery,
  autoOpen,
  recentFiles,
  lastQuery,
  onQueryChange,
}: QuickOpenDialogProps) {
  const adapter = useAdapter();
  const capabilities = useCapabilities();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track whether a search has resolved at least once since the dialog opened.
  // This prevents the auto-open effect from firing before the search starts
  // (when `loading` is still its initial `false` value).
  const searchResolved = useRef(false);

  // Seed query from initialQuery (chat links) or lastQuery when the dialog opens
  useEffect(() => {
    if (open) {
      if (initialQuery) {
        setQuery(initialQuery);
      } else if (lastQuery) {
        setQuery(lastQuery);
        // Select all text so typing immediately replaces it.
        // Use requestAnimationFrame to ensure the input is rendered and focused.
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]');
          input?.select();
        });
      }
    }
  }, [open, initialQuery, lastQuery]);

  // Parse line/column reference from the query (e.g. "src/main.rs:42" -> line 42)
  const parsedQuery = useMemo(() => parseFileLocation(query), [query]);
  const searchQuery = parsedQuery.filePath;

  // Whether to show recent files instead of searching
  const showRecent =
    searchQuery === "" && parsedQuery.line == null && recentFiles && recentFiles.length > 0;

  useEffect(() => {
    if (!open || !adapter.searchWorkspaceFiles) return;

    // Skip file search when the query is a pure go-to-line (":42")
    if (searchQuery === "" && parsedQuery.line != null) {
      setFiles([]);
      setLoading(false);
      searchResolved.current = true;
      return;
    }

    // When query is empty and we have recent files, skip the server search
    if (showRecent) {
      setFiles([]);
      setLoading(false);
      searchResolved.current = true;
      return;
    }

    let cancelled = false;
    setLoading(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const delay = searchQuery ? 150 : 0;
    debounceRef.current = setTimeout(() => {
      // Limit raised from 50 → 200 (issue #530) so substring matches in
      // workspaces with nested git repos / large monorepos can't get
      // pushed off the result list when the user types a short query.
      adapter.searchWorkspaceFiles!(workspaceId, searchQuery, 200)
        .then((result) => {
          if (!cancelled) setFiles(result.files);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
            searchResolved.current = true;
          }
        });
    }, delay);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [adapter, workspaceId, searchQuery, parsedQuery.line, open, showRecent]);

  // Auto-open: wait for the initial search to resolve, then either open the
  // single result directly or reveal the dialog for the user to pick.
  // While waiting, `dialogVisible` stays false so no UI flash occurs.
  const autoOpened = useRef(false);
  const [dialogVisible, setDialogVisible] = useState(!autoOpen);

  // Workspace the dialog was opened against. Captured at the moment of
  // open so a workspace switch in flight (between `open` going true and
  // the search resolving) can't cause the dialog to auto-open the file
  // against the NEW workspace — that's how a chat-file click in
  // workspace A used to leak into workspace B's tab list and write a
  // bogus path into `band-open-tabs:<B>` (issue #539). Even with the
  // workspace-scoped `band:open-file` dispatcher in place, this is the
  // belt-and-braces guard inside the dialog: if `workspaceId` flips
  // between open and resolve, we abandon the auto-open silently rather
  // than running `onOpenFile` against a stale workspace handler.
  const openedWorkspaceIdRef = useRef<string | null>(null);

  // When the dialog opens with autoOpen, hide it until search resolves.
  // When opened normally (no autoOpen), show it immediately.
  // This is needed because useState(!autoOpen) only evaluates on mount —
  // if autoOpen changes later, dialogVisible won't update automatically.
  useEffect(() => {
    if (open) {
      setDialogVisible(!autoOpen);
    }
  }, [open, autoOpen]);

  // Mirror `workspaceId` into a ref so the open-capture effect below
  // can read the current value without depending on it. The capture
  // MUST fire only on the `open: false → true` transition — if the
  // workspaceId changes while the dialog is already open, we must
  // KEEP the originally-captured value (so the bail in the autoOpen
  // effect below has something to compare against). Re-running the
  // capture on every workspaceId change would overwrite the ref with
  // the new workspace, silently defeating the bail and re-opening the
  // cross-workspace leak this guard exists to prevent.
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  useEffect(() => {
    // `workspaceIdRef` is read via the ref so this effect's dep array
    // does NOT include `workspaceId` — including it would re-fire the
    // capture on every workspace switch and silently defeat the bail.
    // This isolation is not covered by an integration test: the bail's
    // exercise path requires the workspace to flip BEFORE the dialog's
    // first search resolves, which is faster than Playwright's
    // black-box await granularity on a tiny test fixture. The
    // correctness here was caught by code review (CI Claude reviewer
    // on PR #545) rather than by a regression test.
    if (open) {
      openedWorkspaceIdRef.current = workspaceIdRef.current;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !autoOpen || autoOpened.current) return;
    if (!searchResolved.current) return; // search hasn't completed yet

    // Bail if the workspace switched while we were waiting for the
    // search. `onOpenFile` is bound to the parent's *current* workspace
    // (e.g. `handleOpenFile(activeWorkspaceId, filename)` in
    // `SharedDockviewLayout`), so firing it after a switch would write
    // the file into the wrong workspace's tab state — exactly the leak
    // path described in issue #539. Closing the dialog cleanly returns
    // the parent to the pre-open state without a bogus tab append.
    if (openedWorkspaceIdRef.current != null && openedWorkspaceIdRef.current !== workspaceId) {
      autoOpened.current = true;
      onOpenChange(false);
      return;
    }

    autoOpened.current = true;
    if (files.length === 1) {
      // Single result — open it directly, never show the dialog
      const location = formatFileLocation(files[0], parsedQuery.line, {
        lineEnd: parsedQuery.lineEnd,
        column: parsedQuery.column,
      });
      onOpenFile(location);
      onOpenChange(false);
    } else {
      // 0 or 2+ results — reveal the dialog so the user can pick
      setDialogVisible(true);
    }
  }, [autoOpen, files, open, parsedQuery, onOpenFile, onOpenChange, workspaceId]);

  // Keep a ref to the current query so the close effect can read it without depending on it
  const queryRef = useRef(query);
  queryRef.current = query;

  // Reset on close — persist the last query first
  useEffect(() => {
    if (!open) {
      // Save the current query before clearing so the parent can restore it
      // on next open. We read from a ref to avoid adding `query` to deps
      // (which would fire this effect on every keystroke).
      onQueryChange?.(queryRef.current);
      setQuery("");
      setFiles([]);
      autoOpened.current = false;
      searchResolved.current = false;
      openedWorkspaceIdRef.current = null;
    }
  }, [open, onQueryChange]);

  // "Go to line in current file" — when query is just ":N" with no filename
  const isGoToLine = parsedQuery.filePath === "" && parsedQuery.line != null;

  const handleGoToLine = useCallback(() => {
    if (!currentFile || parsedQuery.line == null) return;
    const location = formatFileLocation(currentFile, parsedQuery.line, {
      lineEnd: parsedQuery.lineEnd,
      column: parsedQuery.column,
    });
    onOpenFile(location);
    onOpenChange(false);
  }, [currentFile, parsedQuery, onOpenFile, onOpenChange]);

  const handleSelect = useCallback(
    (filePath: string) => {
      const location = formatFileLocation(filePath, parsedQuery.line, {
        lineEnd: parsedQuery.lineEnd,
        column: parsedQuery.column,
      });
      onOpenFile(location);
      onOpenChange(false);
    },
    [onOpenFile, onOpenChange, parsedQuery],
  );

  // "Open File…" entry — surfaces the OS file picker so the user can
  // open a file from anywhere on the local filesystem. Only available
  // when the host shell exposes `pickFile` (i.e. the Electron desktop
  // app); plain browser tabs hide the action.
  const canOpenExternal = !!capabilities.pickFile;
  const handleOpenExternal = useCallback(() => {
    // Dispatch via the same event pattern Quick Open / Search in Files
    // use — CodeBrowserView owns the OS-picker invocation and tab plumbing,
    // so this dialog stays free of workspace-state knowledge.
    //
    // Address the event to *this* workspace: multiple CodeBrowserView
    // instances may be mounted (the workspace dockview is LRU-cached),
    // and an undelimited broadcast would race every cached instance to
    // open its own picker — the file would land in whichever instance
    // won, not the one the user is looking at.
    onOpenChange(false);
    window.dispatchEvent(
      new CustomEvent("band:open-file-external", {
        detail: { workspaceId },
      }),
    );
  }, [onOpenChange, workspaceId]);

  // The list of files to render: recent files when query is empty, search results otherwise
  const displayFiles = showRecent ? recentFiles : files;
  const groupHeading = showRecent ? "Recent files" : undefined;

  return (
    <Dialog open={open && dialogVisible} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="quick-open__root"
        className="overflow-hidden p-0 sm:max-w-[520px]"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Quick Open</DialogTitle>
          <DialogDescription>Search for files by name</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search files by name..."
            value={query}
            onValueChange={setQuery}
          />
          {parsedQuery.line != null && (
            <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">
              Go to line {parsedQuery.line}
              {parsedQuery.lineEnd != null && `-${parsedQuery.lineEnd}`}
              {parsedQuery.column != null && `, column ${parsedQuery.column}`}
              {isGoToLine && currentFile && (
                <span className="ml-1">in {currentFile.split("/").pop()}</span>
              )}
            </div>
          )}
          <CommandList className="max-h-[360px]">
            {isGoToLine && currentFile ? (
              <CommandGroup>
                <CommandItem onSelect={handleGoToLine}>
                  <span className="text-sm">
                    Go to line {parsedQuery.line}
                    {parsedQuery.lineEnd != null && `-${parsedQuery.lineEnd}`} in {currentFile}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : (
              <>
                <CommandEmpty>{loading ? "Searching..." : "No files found."}</CommandEmpty>
                <CommandGroup heading={groupHeading}>
                  {displayFiles.map((file) => {
                    const fileName = file.split("/").pop() || file;
                    const Icon = getFileIcon(fileName);
                    return (
                      <CommandItem key={file} value={file} onSelect={() => handleSelect(file)}>
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <div className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="shrink-0 text-sm font-medium">{fileName}</span>
                          <span className="min-w-0 truncate text-xs text-muted-foreground">
                            {file}
                          </span>
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
                {canOpenExternal && (
                  <CommandGroup heading="Actions">
                    <CommandItem value="__band_open_file_external__" onSelect={handleOpenExternal}>
                      <FileInput className="size-4 shrink-0 text-muted-foreground" />
                      <span className="text-sm">Open File…</span>
                      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                        Pick a file outside this workspace
                        <kbd className="rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[10px]">
                          ⌘O
                        </kbd>
                      </span>
                    </CommandItem>
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
