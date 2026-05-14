/**
 * Dropdown rendered below the browser address-bar input.
 *
 * State lives in `useBrowserPaneControls` (so `BrowserPanelComponent`
 * and `BrowserPaneComponent` share the keyboard wiring); this
 * component is a dumb presentation layer that reads the autocomplete
 * state and emits a single `onSelect(url)` callback when the user
 * clicks (or hovers + keyboard-confirms) a row.
 *
 * Layout — Chrome-omnibox-style overlay:
 *
 *   While the dropdown is open, `useBrowserPaneControls` registers a
 *   manual freeze hold (`useFreezeWhile(autocomplete.isOpen)`). That
 *   makes the parent `BrowserPanel` capture a JPEG snapshot of the
 *   live `WebContentsView`, paint it into the placeholder div, and
 *   hide the native view — same path the popover-on-overlay system
 *   uses. With the native view out of the picture, we can render
 *   this dropdown as a normal `position: absolute` element under
 *   the address bar and it sits cleanly on top of the snapshot.
 *
 *   Anchored to the parent address-bar row, which is `relative` in
 *   `BrowserPanel`. `top-full` drops us right below it; `left/right-0`
 *   spans the full row width; `mx-2` matches the input's horizontal
 *   inset.
 *
 * Uses `onMouseDown` rather than `onClick` for row selection because
 * the address-bar input's `onBlur` runs on click and would otherwise
 * tear the dropdown down before the click commits. `onMouseDown`
 * fires before blur — same trick used by Chrome's omnibox.
 */

import { Globe } from "lucide-react";
import type { AutocompleteState } from "../hooks/useBrowserPaneControls";

export interface AddressBarAutocompleteProps {
  state: AutocompleteState;
  onSelect: (url: string) => void;
}

export function AddressBarAutocomplete({ state, onSelect }: AddressBarAutocompleteProps) {
  if (!state.isOpen || state.items.length === 0) return null;

  return (
    <div
      // Absolutely positioned under the address bar — the address-bar
      // row in `BrowserPanel.tsx` is `relative`, so `top-full` drops
      // this just below the input. `z-20` clears the loading-bar
      // indicator at the row's bottom edge.
      className="absolute top-full left-0 right-0 z-20 mx-2 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-md"
      // Stop blur from closing us mid-click; the row's onMouseDown is
      // the actual commit path.
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    >
      <ul className="max-h-80 overflow-y-auto py-1">
        {state.items.map((item, index) => {
          const selected = index === state.selectedIndex;
          return (
            <li key={item.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(item.url);
                  state.close();
                }}
                onMouseEnter={() => state.setSelectedIndex(index)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                  selected ? "bg-accent text-foreground" : "text-foreground hover:bg-accent/60"
                }`}
              >
                {/* Favicon. Fallback to the lucide Globe glyph when the
                    image fails to load or the row has no favicon URL —
                    cheap and avoids the broken-image icon. */}
                {item.faviconUrl ? (
                  <img
                    src={item.faviconUrl}
                    alt=""
                    className="size-4 shrink-0 rounded-sm"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <Globe className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  {item.title ? (
                    <span className="truncate font-medium leading-tight">{item.title}</span>
                  ) : null}
                  <span
                    className={`truncate text-xs leading-tight ${
                      item.title ? "text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    {item.url}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
