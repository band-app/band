import { getChunks } from "@codemirror/merge";
import { type BlockInfo, BlockType, type EditorView } from "@codemirror/view";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

export type ChangeKind = "added" | "removed" | "modified";

interface ChangeMarker {
  kind: ChangeKind;
  /** Top of the change in the scroller's content coordinates (px). */
  top: number;
  /** Height of the change in the scroller's content coordinates (px). */
  height: number;
}

interface RulerGeometry {
  markers: ChangeMarker[];
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

const EMPTY_GEOMETRY: RulerGeometry = {
  markers: [],
  scrollTop: 0,
  scrollHeight: 0,
  clientHeight: 0,
};

/** Smallest drawn marker, so a one-line change in a long file stays visible. */
const MIN_MARKER_PX = 3;
/** Smallest drawn slider, so it stays grabbable in a very long file. */
const MIN_SLIDER_PX = 20;
/** A track click this close to a marker jumps to the marker, which gives tiny
 *  markers a usable hit target. */
const MARKER_HIT_SLOP_PX = 4;

const MARKER_CLASS: Record<ChangeKind, string> = {
  added: "bg-green-500/80",
  removed: "bg-red-500/80",
  modified: "bg-blue-500/80",
};

/** The block widgets (deleted-lines chunk, split-view spacer) attached to a
 *  line block, or null when the line has none. */
function widgetParts(block: BlockInfo): BlockInfo[] | null {
  if (!Array.isArray(block.type)) return null;
  const parts = (block.type as readonly BlockInfo[]).filter((b) => b.type !== BlockType.Text);
  return parts.length > 0 ? parts : null;
}

/** The text line of a line block, without any block widgets around it. */
function textPart(block: BlockInfo): BlockInfo {
  if (!Array.isArray(block.type)) return block;
  return (block.type as readonly BlockInfo[]).find((b) => b.type === BlockType.Text) ?? block;
}

/** Vertical extent of `[from, to)` in `view`'s document coordinates. An empty
 *  range (a pure deletion in unified mode) resolves to the deleted-lines
 *  widget CodeMirror renders above the line at `from`. */
function rangeExtent(view: EditorView, from: number, to: number): { top: number; bottom: number } {
  const doc = view.state.doc;
  const first = view.lineBlockAt(Math.min(from, doc.length));
  if (to > from) {
    const last = view.lineBlockAt(Math.min(to - 1, doc.length));
    return { top: textPart(first).top, bottom: textPart(last).bottom };
  }
  const widgets = widgetParts(first);
  if (widgets) return { top: widgets[0].top, bottom: widgets[widgets.length - 1].bottom };
  return { top: first.top, bottom: first.top };
}

/** Collect the change markers for the diff's editors, positioned in the
 *  scroller's content coordinates. Unified mode passes one view (the chunks
 *  and the deleted-lines widgets both live in it); split mode passes `[a, b]`,
 *  where additions and modifications are measured on the new side and pure
 *  deletions on the old side. MergeView pads both sides with spacers so the
 *  two editors line up, which keeps the heights comparable. */
function collectMarkers(views: EditorView[], scroller: HTMLElement): ChangeMarker[] {
  if (views.length === 0) return [];
  const newView = views[views.length - 1];
  const oldView = views.length > 1 ? views[0] : newView;
  const result = getChunks(newView.state);
  if (!result) return [];

  const scrollerRect = scroller.getBoundingClientRect();
  const offsetOf = (view: EditorView) => view.documentTop - scrollerRect.top + scroller.scrollTop;
  const newOffset = offsetOf(newView);
  const oldOffset = oldView === newView ? newOffset : offsetOf(oldView);

  const markers: ChangeMarker[] = [];
  for (const chunk of result.chunks) {
    const kind: ChangeKind =
      chunk.fromA === chunk.toA ? "added" : chunk.fromB === chunk.toB ? "removed" : "modified";
    const useOld = kind === "removed" && oldView !== newView;
    const extent = useOld
      ? rangeExtent(oldView, chunk.fromA, chunk.toA)
      : rangeExtent(newView, chunk.fromB, chunk.toB);
    // Unified mode draws a modification's deleted lines as a widget above its
    // new lines; widen the marker to cover both.
    if (kind === "modified" && oldView === newView) {
      const widgets = widgetParts(newView.lineBlockAt(chunk.fromB));
      if (widgets) extent.top = Math.min(extent.top, widgets[0].top);
    }
    const offset = useOld ? oldOffset : newOffset;
    markers.push({
      kind,
      top: offset + extent.top,
      height: Math.max(0, extent.bottom - extent.top),
    });
  }
  return markers;
}

/**
 * VS Code-style overview ruler for a diff: a strip down the right edge of the
 * diff's scroller that stands in for its vertical scrollbar. Colored markers
 * show where the added (green), removed (red) and modified (blue) lines sit in
 * the whole file, and a translucent slider shows the visible part.
 *
 * - Click a marker to scroll it into view.
 * - Click the empty track to center the view on that spot.
 * - Drag the slider to scroll.
 *
 * The scroller should hide its own vertical scrollbar, since this replaces it.
 */
export function DiffOverviewRuler({
  views,
  scrollerRef,
}: {
  views: EditorView[];
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<RulerGeometry>(EMPTY_GEOMETRY);
  const [trackHeight, setTrackHeight] = useState(0);

  const viewsRef = useRef(views);
  viewsRef.current = views;

  const frameRef = useRef(0);
  const scheduleMeasure = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      // A view destroyed between the schedule and the frame (diff reload,
      // view-mode toggle) throws on measurement; the next `views` update
      // re-measures with the live ones.
      let markers: ChangeMarker[] = [];
      try {
        markers = collectMarkers(viewsRef.current, scroller);
      } catch {}
      setGeometry({
        markers,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      });
      setTrackHeight(trackRef.current?.clientHeight ?? 0);
    });
  }, [scrollerRef]);

  // Re-measure on scroll (slider position, and CodeMirror replaces estimated
  // line heights with measured ones as lines render) and whenever the
  // scroller or its content changes size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `views` is read via ref; listed so a new diff or view mode re-measures
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scheduleMeasure();
    scroller.addEventListener("scroll", scheduleMeasure, { passive: true });
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(scroller);
    for (const child of Array.from(scroller.children)) observer.observe(child);
    if (trackRef.current) observer.observe(trackRef.current);
    return () => {
      scroller.removeEventListener("scroll", scheduleMeasure);
      observer.disconnect();
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [views, scrollerRef, scheduleMeasure]);

  const { markers, scrollTop, scrollHeight, clientHeight } = geometry;
  const scale = scrollHeight > 0 ? trackHeight / scrollHeight : 0;
  const overflows = scrollHeight > clientHeight + 1;
  const sliderHeight = Math.max(MIN_SLIDER_PX, clientHeight * scale);
  // Keep a min-height slider inside the track by mapping the scroll range onto
  // the space left over.
  const maxScroll = Math.max(1, scrollHeight - clientHeight);
  const sliderTop = (scrollTop / maxScroll) * Math.max(0, trackHeight - sliderHeight);

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!scroller || !track || scale === 0 || e.button !== 0) return;
    e.preventDefault();
    const y = e.clientY - track.getBoundingClientRect().top;
    const hit = markers.find((m) => {
      const top = m.top * scale;
      const height = Math.max(MIN_MARKER_PX, m.height * scale);
      return y >= top - MARKER_HIT_SLOP_PX && y <= top + height + MARKER_HIT_SLOP_PX;
    });
    // Land a marker a third of the way down the view, with some unchanged
    // context above it; an empty-track click centers on the clicked spot.
    scroller.scrollTop = hit ? hit.top - clientHeight / 3 : y / scale - clientHeight / 2;
  };

  const onSliderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const slider = e.currentTarget;
    slider.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startScrollTop = scroller.scrollTop;
    const pxPerTrackPx = maxScroll / Math.max(1, trackHeight - sliderHeight);
    const onMove = (ev: PointerEvent) => {
      scroller.scrollTop = startScrollTop + (ev.clientY - startY) * pxPerTrackPx;
    };
    const onUp = () => {
      slider.removeEventListener("pointermove", onMove);
      slider.removeEventListener("pointerup", onUp);
      slider.removeEventListener("pointercancel", onUp);
    };
    slider.addEventListener("pointermove", onMove);
    slider.addEventListener("pointerup", onUp);
    slider.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      ref={trackRef}
      className="absolute inset-y-0 right-0 w-3 cursor-default touch-none border-l border-border/50"
      onPointerDown={onTrackPointerDown}
      data-testid="diff-overview-ruler"
      aria-hidden="true"
    >
      {scale > 0 &&
        markers.map((m) => (
          <div
            key={`${m.kind}-${m.top}`}
            className={`pointer-events-none absolute inset-x-0.5 rounded-[1px] ${MARKER_CLASS[m.kind]}`}
            style={{ top: m.top * scale, height: Math.max(MIN_MARKER_PX, m.height * scale) }}
            data-testid={`diff-overview-ruler__marker--${m.kind}`}
          />
        ))}
      {overflows && scale > 0 && (
        <div
          className="absolute inset-x-0 touch-none bg-foreground/10 transition-colors hover:bg-foreground/20 active:bg-foreground/25"
          style={{ top: sliderTop, height: sliderHeight }}
          onPointerDown={onSliderPointerDown}
          data-testid="diff-overview-ruler__slider"
        />
      )}
    </div>
  );
}
