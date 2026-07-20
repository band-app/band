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
import { formatFileLocation, isAbsoluteFilePath, parseFileLocation } from "../lib/file-location";
import { shouldBailAutoOpen } from "../lib/quick-open-bail";

interface QuickOpenDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string) => void;
  /**
   * Open a file that lives OUTSIDE the workspace worktree, by absolute
   * path (optionally with a `:line[:col]` suffix). Offered when the query
   * is an absolute path to an existing file — e.g. a path pasted in, or a
   * terminal/chat link to `/tmp/notes.md`. When omitted, the external
   * "Open file" affordance is not shown.
   */
  onOpenExternalFile?: (path: string) => void;
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
  onOpenExternalFile,
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
  // Result of probing an absolute-path query against the workspace.
  // `resolved` gates auto-open (terminal/chat links) until the probe has
  // settled; `hit` is the file to offer (with the path to open and whether
  // it lives outside the worktree), or null when the query isn't an absolute
  // path / the file is missing / isn't a regular file.
  //
  // This is a single state object (not `hit` state + a `resolved` ref) on
  // purpose: a NON-existent path must still fire a re-render when the probe
  // settles so the auto-open effect re-runs and reveals the dialog. A ref
  // wouldn't change any effect dependency (hit stays null→null), so the
  // effect would never re-run and the dialog would hang invisible.
  //
  // `query` records which query this result is for. State updates are async,
  // so a result for a PRIOR query (e.g. the transient empty query the field
  // holds before `initialQuery` seeds) can linger into the render for the
  // NEXT query; the auto-open effect must not trust a result whose `query`
  // doesn't match the current one, or it would act on a stale `resolved`.
  const [probe, setProbe] = useState<{
    query: string;
    resolved: boolean;
    hit: { openPath: string; external: boolean } | null;
  }>({ query: "", resolved: false, hit: null });
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeStatRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Controlled cmdk selection. We drive the highlighted item ourselves so we
  // can snap it back to the first result whenever the query changes (see the
  // reset effect near the render). The scrollable results list is scrolled to
  // the top at the same time.
  const [selectedValue, setSelectedValue] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

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

  // An absolute-path query isn't a worktree-relative fuzzy match — resolve
  // it against the workspace to find out if it exists and whether it lives
  // inside the worktree (open as a normal file) or outside it (external
  // tab). Gated on the host exposing the resolver. Memoised so it's a stable
  // dependency for the two effects and the `probeReady`/`probeHit` derivations.
  const isAbsoluteQuery = useMemo(
    () => !!adapter.resolveWorkspacePath && isAbsoluteFilePath(searchQuery),
    [adapter.resolveWorkspacePath, searchQuery],
  );

  // Only trust the probe result when it's for the CURRENT query (see the
  // `probe` state comment). `probeReady` gates auto-open; `probeHit` is the
  // offerable file, or null. External hits are only actionable when the host
  // provides `onOpenExternalFile`.
  const probeReady = probe.resolved && probe.query === searchQuery;
  const probeHit =
    probeReady && probe.hit && (!probe.hit.external || onOpenExternalFile) ? probe.hit : null;

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

    // Absolute path → skip the worktree fuzzy search entirely. Matching the
    // absolute string against worktree files would surface unrelated
    // coincidental fuzzy hits — and with autoOpen (terminal/chat links) a
    // single such hit would open the WRONG file. The path-resolve probe
    // effect below owns the loading flag for this case; mark the worktree
    // search trivially resolved (no worktree match) so the autoOpen gate
    // depends only on the probe.
    if (isAbsoluteQuery) {
      setFiles([]);
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
  }, [adapter, workspaceId, searchQuery, parsedQuery.line, open, showRecent, isAbsoluteQuery]);

  // Resolve an absolute-path query against the workspace so we can offer to
  // open it — as a normal file when it lives inside the worktree, or as an
  // external tab when outside (e.g. `/tmp/notes.md` pasted in, or a terminal
  // link that dispatched `band:open-file`). Debounced like the worktree
  // search; owns the `loading` flag while an absolute query is active.
  useEffect(() => {
    if (!open) return;

    if (!isAbsoluteQuery || !adapter.resolveWorkspacePath) {
      // Nothing to probe — mark resolved so the auto-open gate below passes.
      // Also clear `loading`: if a prior probe left it set and the worktree
      // search effect can't clear it (an adapter without `searchWorkspaceFiles`
      // early-returns), the "Searching…" state would otherwise stick.
      setLoading(false);
      setProbe({ query: searchQuery, resolved: true, hit: null });
      return;
    }

    let cancelled = false;
    // Mark unresolved while the debounce + probe are in flight so auto-open
    // waits (and the empty state reads "Searching…" rather than "No files").
    setProbe({ query: searchQuery, resolved: false, hit: null });
    setLoading(true);

    if (probeStatRef.current) clearTimeout(probeStatRef.current);
    probeStatRef.current = setTimeout(() => {
      adapter.resolveWorkspacePath!(workspaceId, searchQuery)
        .then((res) => {
          if (cancelled) return;
          const hit =
            res.exists && res.isFile
              ? {
                  // Inside the worktree → open the workspace-relative path so
                  // it flows through the normal Files-panel / route plumbing.
                  // Outside → open the absolute path as an external tab.
                  openPath: res.external ? searchQuery : (res.workspaceRelativePath ?? searchQuery),
                  external: res.external,
                }
              : null;
          setProbe({ query: searchQuery, resolved: true, hit });
        })
        .catch(() => {
          if (!cancelled) setProbe({ query: searchQuery, resolved: true, hit: null });
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 150);

    return () => {
      cancelled = true;
      if (probeStatRef.current) clearTimeout(probeStatRef.current);
    };
  }, [adapter, workspaceId, searchQuery, isAbsoluteQuery, open]);

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
    // capture on every workspace switch and silently defeat the bail
    // (the ref would track the LATEST workspaceId, so the bail
    // comparison `capturedWorkspaceId !== currentWorkspaceId` would
    // never trip). This timing contract resists end-to-end test
    // coverage because the race window (workspace flips between
    // dialog-open and search-resolve) is faster than Playwright's
    // black-box await granularity on a tiny fixture. The bail's
    // pure decision logic IS covered by the
    // `shouldBailAutoOpen` unit suite.
    if (open) {
      openedWorkspaceIdRef.current = workspaceIdRef.current;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !autoOpen || autoOpened.current) return;
    // Don't decide on the transient empty-query render. `query` starts "" and
    // is seeded to `initialQuery` in a follow-up effect, so the first render
    // after open always has an empty query. Auto-open only ever targets a
    // real filename (or a go-to-line ":N"), so waiting here avoids latching
    // `autoOpened` on the empty phase — where a just-resolved worktree search
    // would otherwise reveal the dialog before the seeded query is searched.
    if (searchQuery === "" && parsedQuery.line == null) return;
    if (!searchResolved.current) return; // worktree search hasn't completed yet
    // For an absolute-path query, also wait for the path-resolve probe so we
    // don't prematurely reveal "No files found" before it resolves.
    if (isAbsoluteQuery && !probeReady) return;

    // Bail if the workspace switched while we were waiting for the
    // search. `onOpenFile` is bound to the parent's *current* workspace
    // (e.g. `handleOpenFile(activeWorkspaceId, filename)` in
    // `SharedDockviewLayout`), so firing it after a switch would write
    // the file into the wrong workspace's tab state — exactly the leak
    // path described in issue #539. Closing the dialog cleanly returns
    // the parent to the pre-open state without a bogus tab append.
    // The decision logic is in `shouldBailAutoOpen` (sibling lib
    // module) so the four-branch contract has direct unit coverage.
    if (shouldBailAutoOpen(openedWorkspaceIdRef.current, workspaceId)) {
      autoOpened.current = true;
      onOpenChange(false);
      return;
    }

    autoOpened.current = true;
    if (probeHit) {
      // Absolute path to an existing file — open it directly, never show the
      // dialog. Inside the worktree → normal (workspace-relative) tab;
      // outside → external tab.
      const location = formatFileLocation(probeHit.openPath, parsedQuery.line, {
        lineEnd: parsedQuery.lineEnd,
        column: parsedQuery.column,
      });
      if (probeHit.external) onOpenExternalFile?.(location);
      else onOpenFile(location);
      onOpenChange(false);
    } else if (files.length === 1) {
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
  }, [
    autoOpen,
    files,
    open,
    parsedQuery,
    onOpenFile,
    onOpenExternalFile,
    onOpenChange,
    workspaceId,
    isAbsoluteQuery,
    probeReady,
    probeHit,
    searchQuery,
  ]);

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
      setProbe({ query: "", resolved: false, hit: null });
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

  // Open the probed absolute-path hit. Re-attaches any `:line[:col]` suffix
  // from the query. Inside the worktree → normal tab (`onOpenFile`); outside
  // → external tab (`onOpenExternalFile`).
  const handleOpenProbed = useCallback(() => {
    if (!probeHit) return;
    const location = formatFileLocation(probeHit.openPath, parsedQuery.line, {
      lineEnd: parsedQuery.lineEnd,
      column: parsedQuery.column,
    });
    if (probeHit.external) onOpenExternalFile?.(location);
    else onOpenFile(location);
    onOpenChange(false);
  }, [probeHit, onOpenFile, onOpenExternalFile, onOpenChange, parsedQuery]);

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

  // Whenever a new result set is applied — the query changed and fresh search
  // results arrived, or we toggled between the recent-files view and a search —
  // snap the highlighted item back to the first result and scroll the list to
  // the top, matching VS Code's Quick Open. Without this, cmdk keeps a stale
  // selection: when the previously highlighted file is still present in the new
  // results (just not first) it stays selected, and the list never scrolls back
  // up on its own — so pressing Enter would open the wrong file.
  //
  // Keyed on the result *contents* (not the array reference) so that repeated
  // clears to an empty list — e.g. the go-to-line path calls `setFiles([])` on
  // every keystroke — don't re-fire and fight cmdk's own single-item selection.
  // Keyboard up/down and hover still update `selectedValue` via `onValueChange`,
  // so this only overrides selection on an actual result change, never
  // mid-navigation.
  const firstFile = useMemo(() => displayFiles[0] ?? "", [displayFiles]);
  // O(N) string allocation — memoised on `displayFiles` so it only recomputes
  // when the result set changes, not on every `selectedValue` / hover render.
  const resultKey = useMemo(() => displayFiles.join("\n"), [displayFiles]);
  // Basename per row, memoised on `displayFiles` so the `split`/`pop` only runs
  // when the result set changes — not on every `selectedValue` render caused by
  // keyboard navigation or hover. Indexed by row position in the map below.
  const fileNames = useMemo(
    () => displayFiles.map((file) => file.split("/").pop() || file),
    [displayFiles],
  );
  // Basename of the external candidate, split on both separators so a
  // Windows path (`C:\Users\me\notes.md`) shows `notes.md` too.
  const probeFileName = useMemo(
    () => (probeHit ? probeHit.openPath.split(/[\\/]/).pop() || probeHit.openPath : ""),
    [probeHit],
  );
  const ProbeFileIcon = getFileIcon(probeFileName);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resultKey is an intentional trigger dependency (fires on any content change, incl. when firstFile is unchanged) — it isn't read in the body
  useEffect(() => {
    // For an absolute-path query the probed item is the primary (only)
    // result, so highlight it — otherwise Enter would do nothing.
    setSelectedValue(probeHit ? probeHit.openPath : firstFile);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [resultKey, firstFile, probeHit]);

  return (
    <Dialog open={open && dialogVisible} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="quick-open__root"
        // Mobile: bottom drawer with the input pinned below the results list.
        // Desktop: floating card anchored in the upper third, input fixed while
        // results grow downward.
        variant="command-palette"
        className="overflow-hidden p-0 lg:max-w-[520px]"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Quick Open</DialogTitle>
          <DialogDescription>Search for files by name</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} value={selectedValue} onValueChange={setSelectedValue}>
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
          <CommandList ref={listRef} className="max-h-[360px]">
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
                {probeHit && (
                  <CommandGroup heading={probeHit.external ? "Open external file" : "Open file"}>
                    <CommandItem
                      value={probeHit.openPath}
                      onSelect={handleOpenProbed}
                      data-testid="quick-open__path-result"
                    >
                      <ProbeFileIcon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="shrink-0 text-sm font-medium">{probeFileName}</span>
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {probeHit.openPath}
                        </span>
                      </div>
                      {probeHit.external && (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          Outside this workspace
                        </span>
                      )}
                    </CommandItem>
                  </CommandGroup>
                )}
                <CommandGroup heading={groupHeading}>
                  {displayFiles.map((file, index) => {
                    const fileName = fileNames[index];
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
