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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdapter } from "../context";
import { getFileIcon } from "../lib/file-icon";
import { formatFileLocation, parseFileLocation } from "../lib/file-location";

interface QuickOpenDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string) => void;
  /** When set, the dialog opens with this query pre-filled. Cleared on close. */
  initialQuery?: string;
  /** When true and only one result is found, auto-open it without showing
   *  the dialog. The dialog is still shown if there are 0 or 2+ results. */
  autoOpen?: boolean;
}

export function QuickOpenDialog({
  workspaceId,
  open,
  onOpenChange,
  onOpenFile,
  initialQuery,
  autoOpen,
}: QuickOpenDialogProps) {
  const adapter = useAdapter();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track whether a search has resolved at least once since the dialog opened.
  // This prevents the auto-open effect from firing before the search starts
  // (when `loading` is still its initial `false` value).
  const searchResolved = useRef(false);

  // Seed query from initialQuery when the dialog opens
  useEffect(() => {
    if (open && initialQuery) {
      setQuery(initialQuery);
    }
  }, [open, initialQuery]);

  // Parse line/column reference from the query (e.g. "src/main.rs:42" -> line 42)
  const parsedQuery = useMemo(() => parseFileLocation(query), [query]);
  const searchQuery = parsedQuery.filePath;

  useEffect(() => {
    if (!open || !adapter.searchWorkspaceFiles) return;

    let cancelled = false;
    setLoading(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const delay = searchQuery ? 150 : 0;
    debounceRef.current = setTimeout(() => {
      adapter.searchWorkspaceFiles!(workspaceId, searchQuery, 50)
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
  }, [adapter, workspaceId, searchQuery, open]);

  // Auto-open: wait for the initial search to resolve, then either open the
  // single result directly or reveal the dialog for the user to pick.
  // While waiting, `dialogVisible` stays false so no UI flash occurs.
  const autoOpened = useRef(false);
  const [dialogVisible, setDialogVisible] = useState(!autoOpen);

  // When the dialog opens with autoOpen, hide it until search resolves.
  // When opened normally (no autoOpen), show it immediately.
  // This is needed because useState(!autoOpen) only evaluates on mount —
  // if autoOpen changes later, dialogVisible won't update automatically.
  useEffect(() => {
    if (open) {
      setDialogVisible(!autoOpen);
    }
  }, [open, autoOpen]);

  useEffect(() => {
    if (!open || !autoOpen || autoOpened.current) return;
    if (!searchResolved.current) return; // search hasn't completed yet

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
  }, [autoOpen, loading, files, open, parsedQuery, onOpenFile, onOpenChange]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery("");
      setFiles([]);
      autoOpened.current = false;
      searchResolved.current = false;
    }
  }, [open]);

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

  return (
    <Dialog open={open && dialogVisible} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[520px]" showCloseButton={false}>
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
            </div>
          )}
          <CommandList className="max-h-[360px]">
            <CommandEmpty>{loading ? "Searching..." : "No files found."}</CommandEmpty>
            <CommandGroup>
              {files.map((file) => {
                const fileName = file.split("/").pop() || file;
                const Icon = getFileIcon(fileName);
                return (
                  <CommandItem key={file} value={file} onSelect={() => handleSelect(file)}>
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="shrink-0 text-sm font-medium">{fileName}</span>
                      <span className="min-w-0 truncate text-xs text-muted-foreground">{file}</span>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
