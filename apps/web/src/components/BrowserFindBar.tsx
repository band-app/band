/**
 * Thin presentational wrapper around the shared `SearchBar` for the
 * browser pane. Renders as a full-width strip directly below the
 * address bar — the WebContentsView shrinks naturally because the
 * strip participates in the flex column.
 *
 * The toggles other than match-case are hidden: Chromium's
 * `webContents.findInPage` only reliably implements `matchCase` —
 * `wholeWord`/`regex` would be silent no-ops.
 */

import { SearchBar } from "@band-app/dashboard-core";
import type { UseBrowserFindInPageReturn } from "../hooks/useBrowserFindInPage";

export function BrowserFindBar({ find }: { find: UseBrowserFindInPageReturn }) {
  if (!find.isOpen) return null;
  return (
    <SearchBar
      ref={find.searchBarRef}
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
