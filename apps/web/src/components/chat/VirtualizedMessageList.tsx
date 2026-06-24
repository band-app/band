/**
 * Virtualized (windowed) renderer for the chat message list.
 *
 * Why this exists — issue #586. Live profiling of the Band desktop
 * renderer found ~88% of the DOM is agent chat history; a 600-turn
 * conversation produced ~30k DOM nodes and ~5.5k streamdown-highlighted
 * code blocks, holding the renderer at ~1 GB resident (peak 2.2 GB).
 * Two forced GC passes reclaimed <1% of nodes — the memory was live,
 * reachable, fully-rendered chat, NOT a detached-node leak. The fix is
 * to mount only the messages near the viewport.
 *
 * Why it lives inside `<StickToBottom.Content>` — TanStack Virtual needs
 * a scroll container ref; `use-stick-to-bottom` already owns the scroll
 * container. We grab the same `scrollRef` from the StickToBottom context
 * so both libraries read/write the same `scrollTop`. The virtualizer
 * exposes its measured `totalSize` as the height of an inner sized div,
 * which the StickToBottom ResizeObserver picks up and treats as "content
 * grew" — so its stick-to-bottom behaviour keeps working on new
 * messages and during streaming.
 *
 * Variable-height rows. Messages contain anything from a one-line user
 * prompt to multiple highlighted code blocks. We use `measureElement`
 * for dynamic measurement (each rendered row's ResizeObserver feeds the
 * virtualizer); the estimate is only used for not-yet-mounted rows.
 *
 * Spacing. The previous flow layout used `[&>*+*]:mt-4` on the parent
 * to space messages; with absolute positioning that descendant selector
 * no longer applies. The inter-message gap is baked into each row's
 * `pb-4` instead, so the measured `size` already includes it.
 *
 * First-paint reveal gate. The same absolute positioning that makes
 * windowing possible also makes the dynamic-height convergence visible
 * as a flicker on the first load of a long conversation — see the
 * `revealed` effect below. We hide the list for the first two animation
 * frames after mount so the measurement cascade runs off-screen, then
 * reveal it pinned to the bottom.
 */

import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";

export interface VirtualizedMessageListProps<T> {
  /** Items to virtualize. Stable identity per item via `getKey`. */
  items: T[];
  /** Stable React key for an item — used by the virtualizer's row map. */
  getKey: (item: T, index: number) => string;
  /** Render a single item. Receives the item and its index in `items`.
   *  Returning `null` is allowed (e.g. for messages with no visible
   *  parts), and the wrapper row collapses to zero height so a skipped
   *  item doesn't contribute a visible gap. */
  renderItem: (item: T, index: number) => ReactNode;
  /**
   * Rough average row height. Used only for not-yet-measured rows so
   * the scrollbar position is plausible on first paint. 220 px is a
   * sensible default for a mixed user/assistant conversation — short
   * user bubbles balance long assistant turns. Measurement converges
   * to the real value within one frame per row.
   */
  estimateSize?: number;
  /**
   * Number of rows to render outside the viewport on each side.
   * Bigger overscan = smoother fast-scroll but more DOM in flight; 5
   * is the TanStack-recommended starting point.
   */
  overscan?: number;
}

export function VirtualizedMessageList<T>({
  items,
  getKey,
  renderItem,
  estimateSize = 220,
  overscan = 5,
}: VirtualizedMessageListProps<T>) {
  const { scrollRef, scrollToBottom } = useStickToBottomContext();

  // First-paint reveal gate — fixes the flickery first load of long
  // conversations. A dynamic-height virtualizer mounts every windowed
  // row at the `estimateSize` guess, then rewrites each row's
  // `translateY(start)` as TanStack's `measureElement` ResizeObserver
  // reports real heights. Because rows are `position:absolute`, the
  // frames where some offsets still use the 220px estimate while others
  // use real measurements briefly OVERLAP (text rendered on top of text);
  // each measurement also bumps the inner height, which the
  // `use-stick-to-bottom` ResizeObserver reads as "content grew" and
  // re-runs its instant scroll-to-bottom — a multi-frame convergence
  // cascade the user otherwise watches live.
  //
  // We keep the list `visibility:hidden` while the convergence runs, pin
  // it to the bottom every frame, and only reveal once the inner height
  // has STOPPED changing — then flip to visible. A blind "wait N frames"
  // reveal is not enough: under load the windowed rows' ResizeObserver
  // measurements can land several frames late, so a fixed-count reveal
  // occasionally fires while the height is still converging, flashing the
  // very jump we're hiding. Waiting for the height to hold steady across
  // consecutive frames removes that race. Because we force `scrollTop` to
  // the bottom on every one of those frames, a stable height also means a
  // pinned scroller, so the reveal lands on the latest message with no
  // jump. `visibility` (not `display:none`) keeps the rows in layout so
  // their ResizeObservers still fire and measurement completes off-screen.
  //
  // This arms ONCE per component instance: `revealed` is instance state
  // and the effect has an empty dependency list, so streaming
  // text-deltas (which re-render this component ~30×/sec without
  // remounting it) never re-gate. A session switch remounts `ChatView`
  // and therefore this component, which re-arms the gate for the next
  // freshly-loaded conversation.
  const [revealed, setRevealed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only gate — must arm exactly once per instance, never on `scrollToBottom`/`scrollRef` identity changes
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let stableFrames = 0;
    let lastHeight = -1;
    // Hard cap (~24 frames ≈ 0.4 s at 60 Hz) so a layout that never
    // settles can't keep the list hidden forever — we reveal anyway.
    const MAX_FRAMES = 24;
    // Consecutive unchanged-height frames required before revealing —
    // proves the convergence cascade has finished, not just paused for a
    // single frame.
    const STABLE_FRAMES = 2;

    const reveal = () => {
      // Sync `use-stick-to-bottom`'s own state once, at reveal time, so it
      // stays in "stick to bottom" mode for subsequent streaming. Per-frame
      // calls during the hidden phase are unnecessary — the raw `scrollTop`
      // write below already keeps us pinned, and `isAtBottom` stays true.
      scrollToBottom("instant");
      setRevealed(true);
    };

    const tick = () => {
      frames += 1;
      const el = scrollRef.current;
      // Keep the scroller pinned to the bottom while hidden. The raw
      // `scrollTop` write mirrors `ChatView`'s visibility-restore fallback
      // and pins synchronously; the browser clamps it to the max, so we
      // stay at the latest message as the height converges.
      if (el) el.scrollTop = el.scrollHeight;

      const height = el ? el.scrollHeight : 0;
      if (height === lastHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
      lastHeight = height;

      if ((stableFrames >= STABLE_FRAMES && frames >= 2) || frames >= MAX_FRAMES) {
        reveal();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Hoist the virtualizer callbacks so their identity is stable across
  // re-renders — during streaming `ChatView` re-renders ~30×/sec and
  // inline arrows would allocate fresh closures each time. The
  // `useVirtualizer` options memoise on identity, so stable callbacks
  // also keep the internal `getMeasurementOptions` memo valid (which
  // gates whether `getMeasurements()` re-walks the full count). For
  // `getItemKey` the cost grows linearly with conversation length, so
  // it's the highest-leverage one to stabilise.
  const estimateSizeFn = useCallback(() => estimateSize, [estimateSize]);
  // Ref-backed `items` reference so `getItemKeyFn`'s closure is
  // stable across re-renders even though `items` itself is a fresh
  // array on every text-delta. The ref stays attached to the latest
  // value via the `.current = items` assignment-on-render; the
  // closure reads through the ref so the virtualizer's internal
  // `getMeasurementOptions` memo holds.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const getItemKeyFn = useCallback(
    (index: number) => getKey(itemsRef.current[index], index),
    [getKey],
  );
  // `scrollRef` is a stable ref object from the StickToBottom context
  // — its `.current` may change but the ref identity does not — so
  // this callback never invalidates after mount.
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement,
    estimateSize: estimateSizeFn,
    overscan,
    // Stable key per item — important so React reuses the same DOM row
    // when items shift (e.g. a new message pushes earlier ones up).
    getItemKey: getItemKeyFn,
  });

  // Scroll-anchor on prepend (issue #572). When older messages are prepended,
  // the previously-first item shifts down by the inserted count and the
  // viewport would jump. We re-pin it to the top via the virtualizer's native
  // `scrollToIndex`, which computes the target offset from its own size cache
  // (measured + estimated) and then keeps converging as the inserted rows
  // measure — so we don't fight TanStack's built-in dynamic-measurement
  // anchoring with a parallel scrollTop writer (that double-counts and drifts).
  //
  // Detection is purely structural: a prepend is the only thing that changes
  // `items[0]`'s key. Streaming deltas append at the END and leave the first
  // key untouched, so this no-ops on the hot path. The mount transition
  // (null → first key) is skipped so we never fight the first-paint reveal gate.
  const prevFirstKeyRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `items`; getKey/virtualizer are stable refs
  useLayoutEffect(() => {
    const firstKey = items.length > 0 ? getKey(items[0], 0) : null;
    const prevFirstKey = prevFirstKeyRef.current;
    prevFirstKeyRef.current = firstKey;
    if (prevFirstKey == null || firstKey === prevFirstKey) return;
    // The previously-first item moved to this index ⇒ that many were prepended.
    const newIndex = items.findIndex((item, i) => getKey(item, i) === prevFirstKey);
    if (newIndex > 0) {
      virtualizer.scrollToIndex(newIndex, { align: "start" });
    }
  }, [items]);

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      data-testid="chat-pane__virtual-list"
      style={{
        // Explicit total height so the parent flex container's
        // ResizeObserver (use-stick-to-bottom) sees growth and the
        // scrollbar shows the correct extent.
        height: `${totalSize}px`,
        width: "100%",
        position: "relative",
        // First-paint reveal gate (see the effect above). Hidden rows
        // still occupy layout — their ResizeObservers keep firing — so
        // the height/offset convergence completes off-screen.
        visibility: revealed ? undefined : "hidden",
      }}
    >
      {virtualItems.map((virtualRow) => {
        const item = items[virtualRow.index];
        const isLast = virtualRow.index === items.length - 1;
        return (
          <VirtualRow
            key={virtualRow.key}
            item={item}
            index={virtualRow.index}
            start={virtualRow.start}
            isLast={isLast}
            renderItem={renderItem}
            measureRef={virtualizer.measureElement}
          />
        );
      })}
    </div>
  );
}

interface VirtualRowProps<T> {
  item: T;
  index: number;
  start: number;
  isLast: boolean;
  renderItem: (item: T, index: number) => ReactNode;
  measureRef: Virtualizer<HTMLElement, Element>["measureElement"];
}

/**
 * Memoized row wrapper — short-circuits the React reconciler for rows
 * whose `(item, index, start, isLast, renderItem, measureRef)` tuple
 * is reference-equal to the previous render. During streaming
 * `ChatView` re-renders ~30×/sec and only the trailing (streaming)
 * message's `item` reference mutates; every other windowed row gets
 * the same `item` reference from the reducer state, so memoizing the
 * row skips the `renderItem` call and the inner Streamdown/Shiki
 * highlight pass for those rows.
 *
 * `renderItem` and `measureRef` are stable across renders (the
 * caller wraps `renderItem` in `useCallback`, and TanStack's
 * `measureElement` is a stable function on the virtualizer
 * instance), so React.memo's default shallow comparison is correct.
 */
function VirtualRowImpl<T>({
  item,
  index,
  start,
  isLast,
  renderItem,
  measureRef,
}: VirtualRowProps<T>) {
  const content = renderItem(item, index);
  // Trailing row has no following sibling — drop the inter-row gap so
  // the conversation doesn't end with an extra 16px of dead space
  // before the queued-messages / thinking sibling outside the
  // virtualized region. Skipped rows (renderItem → null) also drop
  // `pb-4` so an empty assistant turn collapses to zero height
  // instead of leaving a visible gap (matches the pre-virtualization
  // `.map() → null` behaviour).
  const padding = content == null || isLast ? "" : "pb-4";
  return (
    <div
      data-index={index}
      // Skip the testid for null-content rows so `messageRowCount()`
      // only includes rows that actually contain a message — without
      // this the windowing bound would inflate by the count of
      // skipped (renderItem === null) entries.
      data-testid={content == null ? undefined : "chat-pane__message-row"}
      ref={measureRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${start}px)`,
      }}
      // `pb-4` bakes the inter-row gap into the measured size so
      // visual spacing matches the old `[&>*+*]:mt-4` layout without
      // depending on a descendant selector that absolute positioning
      // would defeat.
      className={padding}
    >
      {content}
    </div>
  );
}

// `React.memo` strips the generic parameter from the wrapped
// component's type. Re-cast through `typeof VirtualRowImpl` so
// callers retain inference on the element type `T`.
const VirtualRow = memo(VirtualRowImpl) as typeof VirtualRowImpl;
