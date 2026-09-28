/**
 * Thin presentational wrapper around the shared `SearchBar` for the
 * browser pane. Uses the same floating find widget as the terminal and
 * editor panes, pinned to the top-right corner of the page. The page is a
 * `<webview>` in the pane's DOM, so the widget lays over it like any other
 * element; the pane renders it inside a `relative` box around the page.
 *
 * The toggles other than match-case are hidden: Chromium's
 * `findInPage` only reliably implements `matchCase` —
 * `wholeWord`/`regex` would be silent no-ops.
 */

import { SearchBar } from "@/dashboard";
import type { UseBrowserFindInPageReturn } from "../hooks/useBrowserFindInPage";

export function BrowserFindBar({ find }: { find: UseBrowserFindInPageReturn }) {
  if (!find.isOpen) return null;
  return (
    <SearchBar
      ref={find.searchBarRef}
      variant="floating"
      query={find.query}
      onQueryChange={find.setQuery}
      options={find.options}
      onOptionsChange={find.setOptions}
      placeholder="Find in page"
      matchInfo={find.matchInfo ?? undefined}
      onNext={find.findNext}
      onPrevious={find.findPrevious}
      onClose={find.close}
      visibleOptions={["caseSensitive"]}
    />
  );
}
