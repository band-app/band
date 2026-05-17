/**
 * Markdown preview with built-in find-in-page.
 *
 * Wraps the shared Streamdown renderer with a `Cmd+F` / `Ctrl+F` find bar.
 * Mirrors the CodeMirror editor's find UX (next / previous, "n of m"
 * counter, case / whole-word / regex toggles, Esc to dismiss) so the two
 * surfaces feel consistent — same `SearchBar` component, same options
 * shape, same keyboard model.
 *
 * Highlighting strategy
 * ---------------------
 * Uses the CSS Custom Highlight API (`CSS.highlights` + `::highlight()`)
 * so we never touch the Streamdown subtree. Wrapping matches in `<mark>`
 * tags would race against React: when the file content changes
 * (different file selected, source-mode edit propagating, …) React
 * reconciles its expected text nodes against our injected `<mark>`
 * elements and either tears them out or throws. The highlight API paints
 * `Range` objects as a separate overlay layer, leaving the DOM untouched.
 *
 * Falls back to plain scrolling on browsers without the highlight API:
 * matches still tick through correctly and the counter still updates,
 * just without the yellow paint. (Custom Highlight API ships in
 * Chrome 105+ / Safari 17.2+ / Firefox 140+, which covers every
 * supported Band runtime today, but we keep the fallback in case a
 * future webview disables it.)
 *
 * Keyboard interception
 * ---------------------
 * The `Cmd+F` listener attaches in capture phase on `window`, runs
 * before the editor's `useSearch` (which listens in bubble phase), and
 * calls `stopPropagation` so the editor find bar never opens behind us
 * when the user is viewing the preview. The handler bails out if the
 * preview isn't actually in the layout (e.g. when MarkdownPreview is
 * mounted inside an inactive dockview tab), so multi-tab setups don't
 * fight over the shortcut.
 */

import { SearchBar, type SearchBarHandle, type SearchOptions } from "@band-app/dashboard-core";
import { cn } from "@band-app/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { applyFrontmatterTable } from "../lib/frontmatter";
import { streamdownComponents, streamdownPlugins } from "./streamdown-components";

const DEFAULT_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

// Names registered with `CSS.highlights` for the paint layer. Stylesheet
// in `styles/globals.css` keys off these.
const HIGHLIGHT_NAME = "band-md-find";
const HIGHLIGHT_ACTIVE_NAME = "band-md-find-active";

// Maximum total matches we'll paint. Beyond this point, the Highlight
// API stalls noticeably on huge documents (e.g. a 50k-line plan file
// with a single-character query that matches every space). The counter
// still reflects the true total — we just cap painting.
const MAX_HIGHLIGHTS = 5000;

// ---------- Public API -----------------------------------------------------

interface MarkdownPreviewProps {
  /**
   * Raw file content. Frontmatter is rewritten into a leading markdown
   * table here so callers don't need to apply it themselves.
   */
  content: string;
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const searchBarRef = useRef<SearchBarHandle>(null);

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS);
  const [matchInfo, setMatchInfo] = useState<{ total: number; current: number }>({
    total: 0,
    current: 0,
  });
  // Live match ranges. Kept in a ref so next/previous handlers can step
  // through without re-running the find.
  const rangesRef = useRef<Range[]>([]);
  const activeIndexRef = useRef(0);

  const processedContent = applyFrontmatterTable(content);

  // --------------------------------------------------------------------------
  // Highlight painting
  // --------------------------------------------------------------------------

  const paintHighlights = useCallback((ranges: Range[], activeIndex: number) => {
    const registry = getHighlightRegistry();
    if (!registry) return;
    const HighlightCtor = getHighlightCtor();
    if (!HighlightCtor) return;
    try {
      registry.delete(HIGHLIGHT_NAME);
      registry.delete(HIGHLIGHT_ACTIVE_NAME);
      if (ranges.length === 0) return;

      // Cap painted matches but keep the counter accurate. The "active"
      // range is always painted, even if it falls outside the cap.
      const painted = ranges.slice(0, MAX_HIGHLIGHTS);
      const others = painted.filter((_, i) => i !== activeIndex);
      const active = ranges[activeIndex];
      if (others.length > 0) {
        registry.set(HIGHLIGHT_NAME, new HighlightCtor(...others));
      }
      if (active) {
        registry.set(HIGHLIGHT_ACTIVE_NAME, new HighlightCtor(active));
      }
    } catch {
      // Highlight API can throw if the registry was torn down mid-frame
      // (e.g. component unmounting). Safe to ignore.
    }
  }, []);

  const clearHighlights = useCallback(() => {
    rangesRef.current = [];
    activeIndexRef.current = 0;
    const registry = getHighlightRegistry();
    if (!registry) return;
    try {
      registry.delete(HIGHLIGHT_NAME);
      registry.delete(HIGHLIGHT_ACTIVE_NAME);
    } catch {
      // best effort
    }
  }, []);

  // --------------------------------------------------------------------------
  // Find bar open / close
  // --------------------------------------------------------------------------

  const openFind = useCallback(() => {
    setFindOpen(true);
    // The input only mounts when `findOpen` flips to true — defer the
    // focus to the next frame so it's actually in the DOM.
    requestAnimationFrame(() => {
      searchBarRef.current?.focus();
      searchBarRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setQuery("");
    setMatchInfo({ total: 0, current: 0 });
    clearHighlights();
  }, [clearHighlights]);

  // --------------------------------------------------------------------------
  // Cmd+F / Ctrl+F keybind (capture phase — see file header)
  // --------------------------------------------------------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "f") return;
      const root = contentRef.current;
      // `offsetParent === null` covers `display: none` ancestors —
      // hidden dockview tabs, collapsed panels, etc.
      if (!root || root.offsetParent === null) return;
      e.preventDefault();
      e.stopPropagation();
      openFind();
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [openFind]);

  // --------------------------------------------------------------------------
  // Recompute matches when query / options / content change
  // --------------------------------------------------------------------------
  // useLayoutEffect so highlight paint and counter update commit together.
  // `processedContent` is intentionally a dependency even though it isn't
  // referenced inside the effect body — when the file content changes
  // Streamdown re-renders the DOM, so we need to re-walk it. Biome can't
  // see that the effect reads from `contentRef.current`, hence the
  // suppression below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: processedContent triggers a Streamdown DOM update we must re-walk
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    if (!findOpen || !query) {
      clearHighlights();
      setMatchInfo({ total: 0, current: 0 });
      return;
    }
    const pattern = buildPattern(query, options);
    if (!pattern) {
      clearHighlights();
      setMatchInfo({ total: 0, current: 0 });
      return;
    }
    const ranges = findRanges(root, pattern);
    rangesRef.current = ranges;
    activeIndexRef.current = 0;
    setMatchInfo({ total: ranges.length, current: ranges.length > 0 ? 1 : 0 });
    paintHighlights(ranges, 0);
    if (ranges.length > 0) {
      scrollRangeIntoView(ranges[0]);
    }
  }, [findOpen, query, options, processedContent, clearHighlights, paintHighlights]);

  // Clear the registry entries on unmount so stale ranges don't linger
  // (the Highlight API attaches them to the document, not to the
  // component subtree).
  useEffect(() => clearHighlights, [clearHighlights]);

  // --------------------------------------------------------------------------
  // Next / previous match
  // --------------------------------------------------------------------------

  const stepTo = useCallback(
    (nextIndex: number) => {
      const ranges = rangesRef.current;
      if (ranges.length === 0) return;
      activeIndexRef.current = nextIndex;
      setMatchInfo({ total: ranges.length, current: nextIndex + 1 });
      paintHighlights(ranges, nextIndex);
      scrollRangeIntoView(ranges[nextIndex]);
    },
    [paintHighlights],
  );

  const handleNext = useCallback(() => {
    const total = rangesRef.current.length;
    if (total === 0) return;
    stepTo((activeIndexRef.current + 1) % total);
  }, [stepTo]);

  const handlePrevious = useCallback(() => {
    const total = rangesRef.current.length;
    if (total === 0) return;
    stepTo((activeIndexRef.current - 1 + total) % total);
  }, [stepTo]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------
  return (
    <div className="relative">
      {findOpen && (
        // Negative margins cancel the surrounding `max-w-3xl px-8 py-6`
        // wrapper in `FileViewer` so the bar visually spans the full
        // width of the centered column and meets the top edge of the
        // scroll viewport. `sticky top-0` then pins it as the user
        // scrolls through long documents.
        <div className="sticky top-0 z-10 -mx-8 -mt-6 mb-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
          <SearchBar
            ref={searchBarRef}
            query={query}
            onQueryChange={setQuery}
            options={options}
            onOptionsChange={setOptions}
            placeholder="Find in preview..."
            matchInfo={matchInfo}
            onNext={handleNext}
            onPrevious={handlePrevious}
            onClose={closeFind}
            visibleOptions={["caseSensitive", "wholeWord", "regex"]}
          />
        </div>
      )}
      <div
        ref={contentRef}
        // `band-md-preview` is the hook the Custom Highlight stylesheet
        // uses to scope `::highlight()` to the preview pane — without
        // it, a stray highlight registration would also paint inside
        // unrelated parts of the page (chat messages, settings panes).
        className="band-md-preview"
      >
        <Streamdown
          className={cn(
            "size-full break-words leading-relaxed [overflow-wrap:anywhere]",
            "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          )}
          plugins={streamdownPlugins}
          components={streamdownComponents}
        >
          {processedContent}
        </Streamdown>
      </div>
    </div>
  );
}

// ---------- Helpers --------------------------------------------------------

function buildPattern(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  try {
    let source = options.regex ? query : escapeRegex(query);
    if (options.wholeWord) source = `\\b(?:${source})\\b`;
    const flags = options.caseSensitive ? "gm" : "gim";
    return new RegExp(source, flags);
  } catch {
    // Malformed regex — return null so the caller treats it as "no
    // matches" rather than crashing the preview.
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRanges(root: HTMLElement, pattern: RegExp): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const parent = n.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      // Streamdown shouldn't emit these inside the preview body, but be
      // defensive — script/style content shouldn't count as a match.
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
        return NodeFilter.FILTER_REJECT;
      }
      return n.nodeValue && n.nodeValue.length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = (node as Text).nodeValue ?? "";
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex.exec loop
    while ((m = pattern.exec(text)) !== null) {
      // Guard against zero-width regex matches (e.g. `a*`) — without
      // the manual bump they spin forever.
      if (m[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      ranges.push(range);
    }
    node = walker.nextNode();
  }
  return ranges;
}

function scrollRangeIntoView(range: Range): void {
  const rect = range.getBoundingClientRect();
  // Zero-rect ranges (e.g. inside a `display: none` subtree) can't be
  // meaningfully scrolled to; bail.
  if (rect.width === 0 && rect.height === 0) return;
  // We could call `Range.getBoundingClientRect()` and scroll manually,
  // but the closest element gives the browser enough information to
  // place the match near the centre of the scroll container — and
  // covers the case where the match starts inside an inline element
  // (links, code spans, …) without extra wiring.
  let target: Node | null = range.startContainer;
  while (target && target.nodeType !== Node.ELEMENT_NODE) {
    target = target.parentNode;
  }
  if (!target) return;
  (target as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
}

// ---------- Custom Highlight API (typed defensively) -----------------------
// The Highlight / HighlightRegistry types ship in lib.dom.d.ts in current
// TypeScript versions but the DOM types are still evolving — `globalThis`
// access keeps us forward-compatible without pinning a specific lib
// target.

interface HighlightLike {
  add(range: Range): void;
}

interface HighlightCtor {
  new (...ranges: Range[]): HighlightLike;
}

interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): boolean;
}

function getHighlightRegistry(): HighlightRegistryLike | null {
  if (typeof CSS === "undefined") return null;
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  return registry ?? null;
}

function getHighlightCtor(): HighlightCtor | null {
  const ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  return typeof ctor === "function" ? ctor : null;
}
