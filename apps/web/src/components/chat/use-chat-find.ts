/**
 * Find in a GUI chat pane: Cmd/Ctrl+F opens a find bar that highlights
 * matches in the conversation and steps through them.
 *
 * The message list is virtualized, so most messages aren't in the DOM.
 * Matches are counted on the transcript itself (the user's messages and the
 * agent's text replies, not tool output or thinking); stepping to one
 * scrolls its message into view. Highlights are painted with the CSS Custom
 * Highlight API over the rows that are mounted, so React's DOM is never
 * modified. The `::highlight(chat-find)` styles live in `globals.css`.
 */

import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { isMacPlatform, type SearchBarHandle, type SearchOptions } from "@/dashboard";
import type { ChatMessage } from "./transcript";
import type { VirtualizedMessageListHandle } from "./VirtualizedMessageList";

/** Marks the rendered text a find searches: a user message's text and each
 *  of the agent's text replies. */
export const CHAT_FIND_TEXT_ATTR = "data-chat-find-text";

const DEFAULT_OPTIONS: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };

export function buildFindRegex(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch {
    // An unfinished regex while the user types.
    return null;
  }
}

/** Non-empty matches of `re` in `text`, as [start, end) offsets. */
function matchSpans(text: string, re: RegExp): [number, number][] {
  const spans: [number, number][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") {
      re.lastIndex += 1;
      continue;
    }
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function messageFindText(message: ChatMessage): string {
  if (message.role === "user") return message.text;
  return message.entries.flatMap((e) => (e.kind === "text" ? [e.text] : [])).join("\n");
}

/** Ranges over the marked text in one mounted message row. A match may span
 *  several text nodes (bold, inline code). */
function rangesInRow(row: Element, re: RegExp): Range[] {
  const ranges: Range[] = [];
  for (const scope of row.querySelectorAll(`[${CHAT_FIND_TEXT_ATTR}]`)) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    const starts: number[] = [];
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push(node as Text);
      starts.push(text.length);
      text += (node as Text).data;
    }
    // The last node starting at or before `offset` (before it, for an end).
    const locate = (offset: number, end: boolean): [Text, number] => {
      let i = nodes.length - 1;
      while (i > 0 && (end ? starts[i] >= offset : starts[i] > offset)) i -= 1;
      return [nodes[i], offset - starts[i]];
    };
    for (const [start, end] of matchSpans(text, re)) {
      const range = document.createRange();
      range.setStart(...locate(start, false));
      range.setEnd(...locate(end, true));
      ranges.push(range);
    }
  }
  return ranges;
}

// `CSS.highlights` is one registry per document, and several chat panes can
// have a find open, so each pane's ranges are kept here and painted together.
const paneRanges = new Map<string, { all: Range[]; current: Range | null }>();

function paintHighlights(): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const all: Range[] = [];
  const current: Range[] = [];
  for (const pane of paneRanges.values()) {
    all.push(...pane.all);
    if (pane.current) current.push(pane.current);
  }
  CSS.highlights.set("chat-find", new Highlight(...all));
  CSS.highlights.set("chat-find-current", new Highlight(...current));
}

interface ChatFindMatch {
  messageIndex: number;
  occurrence: number;
}

export interface UseChatFindReturn {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  query: string;
  setQuery: (query: string) => void;
  options: SearchOptions;
  setOptions: (options: SearchOptions) => void;
  /** `{ total, current }` (1-indexed) while there is a query. */
  matchInfo: { total: number; current: number } | undefined;
  findNext: () => void;
  findPrevious: () => void;
  searchBarRef: RefObject<SearchBarHandle | null>;
  /** Put on the pane's root: opens the find bar on Cmd/Ctrl+F. */
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

export function useChatFind({
  messages,
  scrollEl,
  listRef,
  onBeforeScroll,
  onClose,
}: {
  messages: ChatMessage[];
  /** The conversation's scroll container. */
  scrollEl: HTMLElement | null;
  listRef: RefObject<VirtualizedMessageListHandle | null>;
  /** Called before the find scrolls to a match (stops stick-to-bottom). */
  onBeforeScroll?: () => void;
  onClose?: () => void;
}): UseChatFindReturn {
  const paneId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS);
  const [current, setCurrent] = useState(0);
  const searchBarRef = useRef<SearchBarHandle>(null);
  // Set when the current match should be scrolled into view once painted.
  const revealRef = useRef(false);

  const regex = useMemo(
    () => (isOpen ? buildFindRegex(query, options) : null),
    [isOpen, query, options],
  );

  // Counts per message, reused while a message keeps its identity: during
  // streaming only the last message changes.
  const countCache = useRef(new WeakMap<ChatMessage, { re: RegExp; count: number }>());
  const matches = useMemo(() => {
    const out: ChatFindMatch[] = [];
    if (!regex) return out;
    messages.forEach((message, messageIndex) => {
      let cached = countCache.current.get(message);
      if (cached?.re !== regex) {
        cached = { re: regex, count: matchSpans(messageFindText(message), regex).length };
        countCache.current.set(message, cached);
      }
      for (let occurrence = 0; occurrence < cached.count; occurrence++) {
        out.push({ messageIndex, occurrence });
      }
    });
    return out;
  }, [messages, regex]);
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  // A new query starts at the first match in or below the viewport, else the
  // last one above it.
  useEffect(() => {
    if (!regex) return;
    const found = matchesRef.current;
    let firstVisible = Number.POSITIVE_INFINITY;
    if (scrollEl) {
      const top = scrollEl.getBoundingClientRect().top;
      for (const row of scrollEl.querySelectorAll<HTMLElement>("[data-index]")) {
        if (row.getBoundingClientRect().bottom > top) {
          firstVisible = Math.min(firstVisible, Number(row.dataset.index));
        }
      }
    }
    const next = found.findIndex((m) => m.messageIndex >= firstVisible);
    setCurrent(next === -1 ? Math.max(0, found.length - 1) : next);
    revealRef.current = true;
  }, [regex, scrollEl]);

  const currentMatch = matches[Math.min(current, matches.length - 1)];

  const repaint = useCallback(() => {
    if (!regex || !scrollEl) {
      paneRanges.delete(paneId);
      paintHighlights();
      return;
    }
    const all: Range[] = [];
    let currentRange: Range | null = null;
    let targetMounted = false;
    for (const row of scrollEl.querySelectorAll<HTMLElement>("[data-index]")) {
      const ranges = rangesInRow(row, regex);
      all.push(...ranges);
      if (currentMatch && Number(row.dataset.index) === currentMatch.messageIndex) {
        targetMounted = true;
        // The rendered markdown can hold fewer matches than its source.
        currentRange = ranges[Math.min(currentMatch.occurrence, ranges.length - 1)] ?? null;
      }
    }
    paneRanges.set(paneId, { all, current: currentRange });
    paintHighlights();

    if (!revealRef.current || !currentMatch) return;
    if (!targetMounted) {
      onBeforeScroll?.();
      listRef.current?.scrollToIndex(currentMatch.messageIndex);
      return;
    }
    revealRef.current = false;
    if (!currentRange) return;
    const box = currentRange.getBoundingClientRect();
    const view = scrollEl.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom) {
      onBeforeScroll?.();
      scrollEl.scrollTop += box.top - view.top - view.height / 2;
    }
  }, [regex, scrollEl, currentMatch, paneId, listRef, onBeforeScroll]);

  // Repaint when the match moves, and whenever the mounted rows change
  // (scrolling mounts others, streaming rewrites the last one).
  useEffect(() => {
    let raf = requestAnimationFrame(repaint);
    if (!regex || !scrollEl) return () => cancelAnimationFrame(raf);
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(repaint);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(scrollEl, { childList: true, subtree: true, characterData: true });
    scrollEl.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      scrollEl.removeEventListener("scroll", schedule);
    };
  }, [repaint, regex, scrollEl]);

  useEffect(
    () => () => {
      paneRanges.delete(paneId);
      paintHighlights();
    },
    [paneId],
  );

  const open = useCallback(() => {
    setIsOpen(true);
    requestAnimationFrame(() => {
      searchBarRef.current?.focus();
      searchBarRef.current?.select();
    });
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    onClose?.();
  }, [onClose]);

  const step = useCallback((delta: number) => {
    const total = matchesRef.current.length;
    if (total === 0) return;
    setCurrent((c) => (Math.min(c, total - 1) + delta + total) % total);
    revealRef.current = true;
  }, []);
  const findNext = useCallback(() => step(1), [step]);
  const findPrevious = useCallback(() => step(-1), [step]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key.toLowerCase() !== "f" || e.shiftKey || e.altKey) return;
      const mod = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod) return;
      e.preventDefault();
      e.stopPropagation();
      open();
    },
    [open],
  );

  return {
    isOpen,
    open,
    close,
    query,
    setQuery,
    options,
    setOptions,
    matchInfo: regex
      ? {
          total: matches.length,
          current: matches.length > 0 ? matches.indexOf(currentMatch) + 1 : 0,
        }
      : query
        ? { total: 0, current: 0 }
        : undefined,
    findNext,
    findPrevious,
    searchBarRef,
    onKeyDown,
  };
}
