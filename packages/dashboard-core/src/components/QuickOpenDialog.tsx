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
}

export function QuickOpenDialog({
  workspaceId,
  open,
  onOpenChange,
  onOpenFile,
}: QuickOpenDialogProps) {
  const adapter = useAdapter();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          if (!cancelled) setLoading(false);
        });
    }, delay);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [adapter, workspaceId, searchQuery, open]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery("");
      setFiles([]);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
