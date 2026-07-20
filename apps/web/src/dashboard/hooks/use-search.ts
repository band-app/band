import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppShortcut } from "@/hooks/useAppShortcut";
import { GLOBAL_SHORTCUTS } from "@/lib/shortcuts";
import type { SearchBarHandle, SearchOptions } from "../components/SearchBar";
import {
  clearSearch,
  collectSearchMatches,
  dispatchSearch,
  scrollToSearchMatch,
} from "../lib/codemirror-setup";

type SearchMatch = { view: EditorView; from: number; to: number };

const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

interface UseSearchOptions {
  /** Return the current set of editor views to search in. */
  getViews: () => EditorView[];
  /**
   * Optional custom match collector (e.g. for cross-file ordering in DiffView).
   * When omitted the default `collectSearchMatches` is used.
   */
  collectMatches?: (query: string, opts: SearchOptions) => SearchMatch[];
  /** Called when the find-in-file open callback changes (for Cmd+F integration). */
  onFindInFile?: ((fn: (() => void) | null) => void) | null;
}

export interface UseSearchReturn {
  /** Whether the search bar is open. */
  searchOpen: boolean;
  /** Current search query text. */
  searchQuery: string;
  /** Current search option toggles. */
  searchOptions: SearchOptions;
  /** Match counter info for the SearchBar. */
  matchInfo: { total: number; current: number };
  /** Ref to attach to the SearchBar component. */
  searchBarRef: React.RefObject<SearchBarHandle | null>;
  /** Open the search bar and focus it. */
  handleOpenSearch: () => void;
  /** Close the search bar and clear all highlights. */
  handleCloseSearch: () => void;
  /** Navigate to the next match. */
  handleNext: () => void;
  /** Navigate to the previous match. */
  handlePrevious: () => void;
  /** Update the query text (pass as `onQueryChange` to SearchBar). */
  setSearchQuery: (q: string) => void;
  /** Update the option toggles (pass as `onOptionsChange` to SearchBar). */
  setSearchOptions: (opts: SearchOptions) => void;
  /**
   * Dispatch the current search query to specific views.
   * Call this when new editor views are registered after the search is already active.
   */
  dispatchToViews: (views: EditorView[]) => void;
}

export function useSearch({
  getViews,
  collectMatches,
  onFindInFile,
}: UseSearchOptions): UseSearchReturn {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQueryText] = useState("");
  const [searchOptions, setSearchOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const searchQueryRef = useRef("");
  const searchOptionsRef = useRef<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [matchInfo, setMatchInfo] = useState<{ total: number; current: number }>({
    total: 0,
    current: 0,
  });
  const currentMatchIndexRef = useRef(0);
  const searchBarRef = useRef<SearchBarHandle>(null);

  // Keep refs in sync with state so callbacks always read the latest value.
  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);
  useEffect(() => {
    searchOptionsRef.current = searchOptions;
  }, [searchOptions]);

  // Stable ref for getViews / collectMatches so callbacks don't re-create.
  const getViewsRef = useRef(getViews);
  getViewsRef.current = getViews;
  const collectMatchesRef = useRef(collectMatches);
  collectMatchesRef.current = collectMatches;

  const getMatches = useCallback((query: string, opts: SearchOptions): SearchMatch[] => {
    if (collectMatchesRef.current) return collectMatchesRef.current(query, opts);
    return collectSearchMatches(getViewsRef.current(), query, opts);
  }, []);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleOpenSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchBarRef.current?.focus();
      searchBarRef.current?.select();
    });
  }, []);

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQueryText("");
    currentMatchIndexRef.current = 0;
    clearSearch(getViewsRef.current());
  }, []);

  const handleNext = useCallback(() => {
    const matches = getMatches(searchQueryRef.current, searchOptionsRef.current);
    if (matches.length === 0) return;
    currentMatchIndexRef.current = (currentMatchIndexRef.current + 1) % matches.length;
    const match = matches[currentMatchIndexRef.current];
    scrollToSearchMatch(match);
    match.view.dom.scrollIntoView({ block: "nearest" });
    setMatchInfo({ total: matches.length, current: currentMatchIndexRef.current + 1 });
  }, [getMatches]);

  const handlePrevious = useCallback(() => {
    const matches = getMatches(searchQueryRef.current, searchOptionsRef.current);
    if (matches.length === 0) return;
    currentMatchIndexRef.current =
      (currentMatchIndexRef.current - 1 + matches.length) % matches.length;
    const match = matches[currentMatchIndexRef.current];
    scrollToSearchMatch(match);
    match.view.dom.scrollIntoView({ block: "nearest" });
    setMatchInfo({ total: matches.length, current: currentMatchIndexRef.current + 1 });
  }, [getMatches]);

  const setSearchQuery = useCallback((q: string) => {
    setSearchQueryText(q);
    currentMatchIndexRef.current = 0;
  }, []);

  const dispatchToViews = useCallback((views: EditorView[]) => {
    if (searchQueryRef.current) {
      dispatchSearch(views, searchQueryRef.current, searchOptionsRef.current);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Dispatch search to all editors and count matches when query or options change.
  useEffect(() => {
    const views = getViewsRef.current();
    dispatchSearch(views, searchQuery, searchOptions);

    if (!searchQuery) {
      setMatchInfo({ total: 0, current: 0 });
      currentMatchIndexRef.current = 0;
      return;
    }

    const matches = getMatches(searchQuery, searchOptions);
    currentMatchIndexRef.current = 0;
    setMatchInfo({ total: matches.length, current: matches.length > 0 ? 1 : 0 });
  }, [searchQuery, searchOptions, getMatches]);

  // Report find-in-file callback to parent (for Cmd+F integration).
  useEffect(() => {
    onFindInFile?.(handleOpenSearch);
    return () => onFindInFile?.(null);
  }, [onFindInFile, handleOpenSearch]);

  // Direct Cmd+F / Ctrl+F binding so the search works even when the parent
  // layout does not provide a FindInFileContext (e.g. desktop / mobile). Shares
  // the `findInFile` combo with the global binding in `SharedDockviewLayout`;
  // that one prefers a registered per-workspace handler and only broadcasts as
  // a fallback, so the two don't fight over the same keystroke.
  useAppShortcut(GLOBAL_SHORTCUTS.findInFile, () => handleOpenSearch(), {}, [handleOpenSearch]);

  return {
    searchOpen,
    searchQuery,
    searchOptions,
    matchInfo,
    searchBarRef,
    handleOpenSearch,
    handleCloseSearch,
    handleNext,
    handlePrevious,
    setSearchQuery,
    setSearchOptions,
    dispatchToViews,
  };
}
