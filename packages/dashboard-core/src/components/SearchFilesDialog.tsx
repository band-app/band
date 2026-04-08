import {
  Command,
  CommandEmpty,
  CommandGroup,
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
import { formatFileLocation } from "../lib/file-location";
import type { ContentSearchMatch } from "../types";
import { SearchBar, type SearchBarHandle, type SearchOptions } from "./SearchBar";

interface SearchFilesDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string) => void;
}

export function SearchFilesDialog({
  workspaceId,
  open,
  onOpenChange,
  onOpenFile,
}: SearchFilesDialogProps) {
  const adapter = useAdapter();
  const [query, setQuery] = useState("");
  const [searchOptions, setSearchOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [results, setResults] = useState<ContentSearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchBarRef = useRef<SearchBarHandle>(null);

  useEffect(() => {
    if (!open || !adapter.searchWorkspaceContent || query.length < 2) {
      if (query.length < 2) setResults([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      adapter.searchWorkspaceContent!(workspaceId, query, {
        caseSensitive: searchOptions.caseSensitive,
        wholeWord: searchOptions.wholeWord,
        regex: searchOptions.regex,
        limit: 100,
      })
        .then((result) => {
          if (!cancelled) {
            setResults(result.results);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [adapter, workspaceId, query, searchOptions, open]);

  // Reset on close, auto-focus on open
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
    } else {
      requestAnimationFrame(() => searchBarRef.current?.focus());
    }
  }, [open]);

  // Group results by file
  const grouped = useMemo(() => {
    const map = new Map<string, ContentSearchMatch[]>();
    for (const r of results) {
      const list = map.get(r.file) || [];
      list.push(r);
      map.set(r.file, list);
    }
    return Array.from(map.entries());
  }, [results]);

  const handleSelect = useCallback(
    (filePath: string, line: number) => {
      onOpenFile(formatFileLocation(filePath, line));
      onOpenChange(false);
    },
    [onOpenFile, onOpenChange],
  );

  const totalMatches = results.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[640px]" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search in Files</DialogTitle>
          <DialogDescription>Text search across workspace files</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false}>
          <SearchBar
            ref={searchBarRef}
            query={query}
            onQueryChange={setQuery}
            options={searchOptions}
            onOptionsChange={setSearchOptions}
            placeholder="Search in files..."
          />
          <CommandList className="max-h-[400px]">
            <CommandEmpty>
              {loading
                ? "Searching..."
                : query.length < 2
                  ? "Type at least 2 characters to search."
                  : "No results found."}
            </CommandEmpty>
            {grouped.map(([file, matches]) => {
              const FileIcon = getFileIcon(file);
              return (
                <CommandGroup
                  key={file}
                  heading={
                    <span className="inline-flex items-center gap-1.5">
                      <FileIcon className="size-3" />
                      {file}
                    </span>
                  }
                >
                  {matches.map((match) => (
                    <CommandItem
                      key={`${file}:${match.line}:${match.content}`}
                      value={`${file}:${match.line}:${match.content}`}
                      onSelect={() => handleSelect(file, match.line)}
                    >
                      <span className="w-8 shrink-0 text-right font-mono text-xs text-muted-foreground">
                        {match.line}
                      </span>
                      <span className="min-w-0 truncate font-mono text-xs">{match.content}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
          {totalMatches > 0 && (
            <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
              {totalMatches} result{totalMatches !== 1 ? "s" : ""} in {grouped.length} file
              {grouped.length !== 1 ? "s" : ""}
            </div>
          )}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
