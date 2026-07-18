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
  const [selectedValue, setSelectedValue] = useState("");
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchBarRef = useRef<SearchBarHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Auto-focus and select text on open so typing replaces previous query
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        searchBarRef.current?.focus();
        searchBarRef.current?.select();
      });
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

  // Whenever a new result set is applied, snap the highlighted item back to the
  // first result and scroll the list to the top, matching VS Code and the Quick
  // Open dialog. cmdk runs with `shouldFilter={false}` here, so it never re-runs
  // its own select-first logic on a query change: a match that survives a query
  // refinement (its `file:line:content` value still present in the new results,
  // just not first) would otherwise stay selected with the list scrolled down,
  // and pressing Enter would open the wrong match.
  //
  // Keyed on the result *contents* (not the array reference) so repeated clears
  // to an empty list — a query under 2 chars sets `results` to [] — don't
  // re-fire and fight cmdk's own single-item selection. Keyboard up/down and
  // hover still update `selectedValue` via `onValueChange`, so this only
  // overrides selection on an actual result change, never mid-navigation.
  const itemValues = useMemo(
    () =>
      grouped.flatMap(([file, matches]) => matches.map((m) => `${file}:${m.line}:${m.content}`)),
    [grouped],
  );
  const firstValue = itemValues[0] ?? "";
  const resultKey = itemValues.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: resultKey is an intentional trigger dependency (fires on any content change, incl. when firstValue is unchanged) — it isn't read in the body
  useEffect(() => {
    setSelectedValue(firstValue);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [resultKey, firstValue]);

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
      <DialogContent
        data-testid="search-files__root"
        // Mobile: bottom drawer with the search bar pinned below the results
        // list. Desktop: floating card anchored in the upper third, search bar
        // fixed while results grow downward.
        variant="command-palette"
        className="overflow-hidden p-0 lg:max-w-[640px]"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search in Files</DialogTitle>
          <DialogDescription>Text search across workspace files</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} value={selectedValue} onValueChange={setSelectedValue}>
          <SearchBar
            ref={searchBarRef}
            query={query}
            onQueryChange={setQuery}
            options={searchOptions}
            onOptionsChange={setSearchOptions}
            placeholder="Search in files..."
            // On mobile the search bar sits at the bottom of the sheet (below
            // the list), so its divider flips to a top border.
            className="max-lg:border-t max-lg:border-b-0"
          />
          <CommandList ref={listRef} className="max-h-[400px]">
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
