/**
 * Thin presentational wrapper around the shared `SearchBar` for the
 * browser pane. Uses the same floating find widget as the terminal and
 * editor panes, pinned to the top-right corner under the address bar.
 *
 * Unlike the other panes the widget cannot be laid over the page: the
 * native WebContentsView paints above every DOM element in its bounds.
 * So the widget sits in a slot that participates in the flex column and
 * the WebContentsView shrinks by the slot's height while find is open.
 *
 * The toggles other than match-case are hidden: Chromium's
 * `webContents.findInPage` only reliably implements `matchCase` —
 * `wholeWord`/`regex` would be silent no-ops.
 */

import { SearchBar } from "@/dashboard";
import type { UseBrowserFindInPageReturn } from "../hooks/useBrowserFindInPage";

export function BrowserFindBar({ find }: { find: UseBrowserFindInPageReturn }) {
  if (!find.isOpen) return null;
  return (
    <div className="flex shrink-0 justify-end px-4 py-1.5">
      <SearchBar
        ref={find.searchBarRef}
        variant="floating"
        className="static"
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
    </div>
  );
}
