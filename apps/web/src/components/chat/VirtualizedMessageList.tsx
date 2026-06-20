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
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback } from "react";
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
  const { scrollRef } = useStickToBottomContext();

  // Hoist the virtualizer callbacks so their identity is stable across
  // re-renders — during streaming `ChatView` re-renders ~30×/sec and
  // inline arrows would allocate fresh closures each time. The
  // `useVirtualizer` options memoise on identity, so stable callbacks
  // also keep the internal `getMeasurementOptions` memo valid (which
  // gates whether `getMeasurements()` re-walks the full count). For
  // `getItemKey` the cost grows linearly with conversation length, so
  // it's the highest-leverage one to stabilise.
  const estimateSizeFn = useCallback(() => estimateSize, [estimateSize]);
  const getItemKeyFn = useCallback((index: number) => getKey(items[index], index), [items, getKey]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateSizeFn,
    overscan,
    // Stable key per item — important so React reuses the same DOM row
    // when items shift (e.g. a new message pushes earlier ones up).
    getItemKey: getItemKeyFn,
  });

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
      }}
    >
      {virtualItems.map((virtualRow) => {
        const item = items[virtualRow.index];
        const content = renderItem(item, virtualRow.index);
        // Trailing row has no following sibling — drop the inter-row
        // gap so the conversation doesn't end with an extra 16px of
        // dead space before the queued-messages / thinking sibling
        // outside the virtualized region. Skipped rows (renderItem →
        // null) also drop `pb-4` so an empty assistant turn collapses
        // to zero height instead of leaving a visible gap (matches
        // the pre-virtualization `.map() → null` behaviour).
        const isLast = virtualRow.index === items.length - 1;
        const padding = content == null || isLast ? "" : "pb-4";
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            data-testid="chat-pane__message-row"
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
            // `pb-4` bakes the inter-row gap into the measured size so
            // visual spacing matches the old `[&>*+*]:mt-4` layout
            // without depending on a descendant selector that absolute
            // positioning would defeat.
            className={padding}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}
