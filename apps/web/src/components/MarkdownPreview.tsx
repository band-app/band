/**
 * Markdown preview with imperative find-in-page.
 *
 * The component is a *search target*, not a search UI — the parent
 * (`CodeBrowserView`) renders one shared `SearchBar` for both source
 * and preview modes and drives this component through an imperative
 * ref. Two reasons:
 *
 *   1. Avoid duplicate find bars on `Cmd+F`. `SharedDockviewLayout`
 *      and `useSearch` both register window-level keybinds, and any
 *      preview-local handler we add ends up running alongside (not
 *      instead of) the one routed to the editor — last time we shipped
 *      it that way, users saw two find bars stacked on top of each
 *      other in markdown preview tabs.
 *   2. Visual consistency. Editor and preview should look like the same
 *      surface, since the toggle between them is invisible to muscle
 *      memory.
 *
 * Highlighting strategy
 * ---------------------
 * Uses the CSS Custom Highlight API (`CSS.highlights` + `::highlight()`)
 * so we never touch the Streamdown subtree. Wrapping matches in `<mark>`
 * tags would race against React: when the file content changes
 * (different file, source-mode edit propagating, …) React reconciles
 * its expected text nodes against our injected `<mark>` elements and
 * tears them out. The highlight API paints `Range` objects on a
 * separate overlay layer, leaving the DOM untouched.
 *
 * Falls back to plain navigation (no paint) on browsers without the
 * Custom Highlight API. Matches still tick through and the counter
 * still updates. (Chrome 105+, Safari 17.2+, Firefox 140+ all ship it,
 * which covers every supported Band runtime today.)
 */

import type { SearchOptions } from "@band-app/dashboard-core";
import { cn } from "@band-app/ui";
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Streamdown } from "streamdown";
import { applyFrontmatterTable } from "../lib/frontmatter";
import { streamdownComponents, streamdownPlugins } from "./streamdown-components";

// Names registered with `CSS.highlights` for the paint layer. The
// stylesheet in `styles/globals.css` keys off these.
//
// NOTE: these are document-level singleton slots — only one
// `MarkdownPreview` instance can paint at a time. That's fine for the
// current dockview layout (the Files panel shows one file at a time),
// but if a split-pane preview is ever added, each instance will need a
// unique suffix or both will overwrite the other's highlights.
const HIGHLIGHT_NAME = "band-md-find";
const HIGHLIGHT_ACTIVE_NAME = "band-md-find-active";

// Maximum total matches we'll paint. Beyond this point, the Highlight
// API stalls noticeably on huge documents (e.g. a 50k-line plan file
// with a single-character query that matches every space). The counter
// still reflects the true total — we just cap painting.
const MAX_HIGHLIGHTS = 5000;

// ---------- Public API -----------------------------------------------------

export interface MarkdownPreviewMatchInfo {
  /** Total matches across the document. */
  total: number;
  /** 1-indexed position of the currently-active match, or 0 when there are no matches. */
  current: number;
}

export interface MarkdownPreviewHandle {
  /**
   * Search the rendered preview for `query` honouring the given
   * options. Resets the active index to the first match. Match-info
   * updates are reported through `onMatchInfoChange`.
   */
  search(query: string, options: SearchOptions): void;
  /** Advance to the next match (with wrap-around). No-op when there are no matches. */
  next(): void;
  /** Move to the previous match (with wrap-around). No-op when there are no matches. */
  previous(): void;
  /** Clear all highlights and reset internal state. */
  clear(): void;
}

interface MarkdownPreviewProps {
  /**
   * Raw file content. Frontmatter is rewritten into a leading markdown
   * table here so callers don't need to apply it themselves.
   */
  content: string;
  /**
   * Called whenever the match counter changes — after a `search()`,
   * after a `next()` / `previous()`, after the content changes and the
   * stored query re-runs, and after a `clear()`. Use this to drive the
   * shared SearchBar's `matchInfo` prop.
   */
  onMatchInfoChange?: (info: MarkdownPreviewMatchInfo) => void;
}

export const MarkdownPreview = forwardRef<MarkdownPreviewHandle, MarkdownPreviewProps>(
  function MarkdownPreview({ content, onMatchInfoChange }, forwardedRef) {
    const contentRef = useRef<HTMLDivElement>(null);

    // Persisted-across-renders state. Refs (not React state) because
    // none of this drives the render — the highlight paint and scroll
    // are imperative side effects, and match-info propagates through
    // the `onMatchInfoChange` callback.
    const queryRef = useRef("");
    const optionsRef = useRef<SearchOptions>({
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    const rangesRef = useRef<Range[]>([]);
    const activeIndexRef = useRef(0);
    const onMatchInfoChangeRef = useRef(onMatchInfoChange);
    onMatchInfoChangeRef.current = onMatchInfoChange;

    const processedContent = applyFrontmatterTable(content);

    // ------------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------------

    const emitMatchInfo = useCallback(() => {
      const total = rangesRef.current.length;
      const current = total === 0 ? 0 : activeIndexRef.current + 1;
      onMatchInfoChangeRef.current?.({ total, current });
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

    const paintHighlights = useCallback((ranges: Range[], activeIndex: number) => {
      const registry = getHighlightRegistry();
      if (!registry) return;
      const HighlightCtor = getHighlightCtor();
      if (!HighlightCtor) return;
      try {
        registry.delete(HIGHLIGHT_NAME);
        registry.delete(HIGHLIGHT_ACTIVE_NAME);
        if (ranges.length === 0) return;

        // Cap painted matches but keep the counter accurate. The
        // "active" range is always painted, even if it falls outside
        // the cap.
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
        // Highlight API can throw if the registry was torn down
        // mid-frame (e.g. unmount). Safe to ignore.
      }
    }, []);

    const runSearch = useCallback(
      (opts: { scroll: boolean }) => {
        const root = contentRef.current;
        if (!root) return;
        const query = queryRef.current;
        const options = optionsRef.current;
        if (!query) {
          clearHighlights();
          emitMatchInfo();
          return;
        }
        const pattern = buildPattern(query, options);
        if (!pattern) {
          clearHighlights();
          emitMatchInfo();
          return;
        }
        const ranges = findRanges(root, pattern);
        rangesRef.current = ranges;
        activeIndexRef.current = 0;
        paintHighlights(ranges, 0);
        if (opts.scroll && ranges.length > 0) {
          scrollRangeIntoView(ranges[0]);
        }
        emitMatchInfo();
      },
      [clearHighlights, paintHighlights, emitMatchInfo],
    );

    // ------------------------------------------------------------------------
    // Imperative API
    // ------------------------------------------------------------------------

    useImperativeHandle(
      forwardedRef,
      (): MarkdownPreviewHandle => ({
        search(query, options) {
          queryRef.current = query;
          optionsRef.current = options;
          runSearch({ scroll: true });
        },
        next() {
          const ranges = rangesRef.current;
          if (ranges.length === 0) return;
          const nextIndex = (activeIndexRef.current + 1) % ranges.length;
          activeIndexRef.current = nextIndex;
          paintHighlights(ranges, nextIndex);
          scrollRangeIntoView(ranges[nextIndex]);
          emitMatchInfo();
        },
        previous() {
          const ranges = rangesRef.current;
          if (ranges.length === 0) return;
          const prevIndex = (activeIndexRef.current - 1 + ranges.length) % ranges.length;
          activeIndexRef.current = prevIndex;
          paintHighlights(ranges, prevIndex);
          scrollRangeIntoView(ranges[prevIndex]);
          emitMatchInfo();
        },
        clear() {
          queryRef.current = "";
          clearHighlights();
          emitMatchInfo();
        },
      }),
      [runSearch, paintHighlights, clearHighlights, emitMatchInfo],
    );

    // ------------------------------------------------------------------------
    // Re-run the stored query when the rendered content changes
    // ------------------------------------------------------------------------
    // Streamdown re-renders the DOM whenever the source content
    // changes (file switch, source-mode edit, frontmatter refresh).
    // Stored `Range` objects point at the *old* text nodes after a
    // re-render, so we re-walk the new DOM with the current query.
    // useLayoutEffect keeps the paint and the new DOM commit in the
    // same frame.
    //
    // `processedContent` is the real trigger — the effect re-runs the
    // *stored* query against the *new* DOM — but biome can't see the
    // dependency through Streamdown's render closure, hence the
    // suppression.
    // biome-ignore lint/correctness/useExhaustiveDependencies: processedContent triggers a Streamdown DOM update we must re-walk
    useLayoutEffect(() => {
      runSearch({ scroll: false });
    }, [runSearch, processedContent]);

    // Clear the registry entries on unmount so stale ranges don't
    // linger (the Highlight API attaches them to the document, not
    // to the component subtree).
    useLayoutEffect(() => clearHighlights, [clearHighlights]);

    // ------------------------------------------------------------------------
    // Render
    // ------------------------------------------------------------------------
    return (
      <div
        ref={contentRef}
        // Highlight scoping is enforced by the *Range geometry*, not by
        // this class. `findRanges(root, …)` only walks inside
        // `contentRef`, so no `::highlight()` paint can land outside the
        // preview. (Browsers don't honour ancestor selectors on the
        // `::highlight()` pseudo-element — `.band-md-preview
        // ::highlight(name)` would be a no-op.) The class is kept as a
        // hook for non-highlight styles only.
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
    );
  },
);

// ---------- Helpers --------------------------------------------------------

function buildPattern(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  try {
    let source = options.regex ? query : escapeRegex(query);
    // Skip the word-boundary wrap when the user is already in regex mode:
    // their pattern can end in an anchor (`$`, `\b`, …) and wrapping it
    // in `\b(?:…)\b` produces a malformed expression like
    // `\b(?:(foo|bar)$)\b`. RegExp construction throws and we'd silently
    // fall back to "no matches" with no feedback.
    if (options.wholeWord && !options.regex) {
      source = `\\b(?:${source})\\b`;
    }
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
      // Streamdown shouldn't emit these inside the preview body, but
      // be defensive — script/style content shouldn't count as a
      // match.
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
  let target: Node | null = range.startContainer;
  while (target && target.nodeType !== Node.ELEMENT_NODE) {
    target = target.parentNode;
  }
  if (!target) return;
  (target as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
}

// ---------- Custom Highlight API (typed defensively) -----------------------

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
