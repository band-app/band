import * as Haptics from "expo-haptics";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { dropIndex, shiftFor } from "../lib/reordering";

/** A held block: the cells that move with the finger and the sibling blocks they pass. */
export interface ActiveDrag {
  /** The block being dragged, as an index into `blocks`. */
  from: number;
  /** Cell keys of each sibling block, in display order. */
  blocks: string[][];
  heights: number[];
  /** Called when the drop settles on a position different from `from`. */
  commit: (to: number) => void;
  /** What the finger carries: a copy of the held block's first cell, drawn above the list. */
  overlay?: { node: ReactNode; x: number; y: number; width: number; height: number };
}

interface DragState {
  drag: ActiveDrag | null;
  target: number;
  dragY: SharedValue<number>;
}

const DragContext = createContext<DragState | null>(null);

export const HOLD_MS = 350;
/** A finger that moved less than this between the hold and the release meant a long press. */
const TAP_SLOP = 8;
const EDGE = 90;
const MAX_SCROLL_STEP = 18;

export interface ListDrag {
  state: DragState;
  /** Top of the list in window coordinates, for placing the overlay. */
  viewportTop: () => number;
  /** True while a block is held, so the list can stop scrolling. */
  active: boolean;
  begin: (drag: ActiveDrag, absoluteY: number) => void;
  update: (translationY: number, absoluteY: number) => void;
  end: (translationY: number) => void;
  cancel: () => void;
  isActive: () => boolean;
  /** The last drag distance, which a touch release uses when the gesture reports none. */
  lastTranslation: () => number;
  /** Scroll bookkeeping the list wires to its `onScroll` and layout. */
  onScroll: (y: number) => void;
  setViewport: (top: number, bottom: number) => void;
  /** Content and visible heights, which bound the auto-scroll. */
  setBounds: (content: number, visible: number) => void;
}

/**
 * Drag state for one scrolling list. A held block follows the finger through `dragY`, the sibling
 * blocks it passes shift by its height, and the list scrolls when the finger nears an edge. The
 * list passes `scrollTo` to move itself.
 */
export function useListDrag(scrollTo: (y: number) => void): ListDrag {
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const [target, setTarget] = useState(0);
  const dragY = useSharedValue(0);
  const dragRef = useRef<ActiveDrag | null>(null);
  const targetRef = useRef(0);
  const scrollY = useRef(0);
  const maxScroll = useRef(0);
  const startScroll = useRef(0);
  const translation = useRef(0);
  const fingerY = useRef(0);
  const viewport = useRef({ top: 0, bottom: 0 });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const move = useCallback(() => {
    const current = dragRef.current;
    if (!current) return;
    const dy = translation.current + (scrollY.current - startScroll.current);
    dragY.value = translation.current;
    const next = dropIndex(current.heights, current.from, dy);
    if (next !== targetRef.current) {
      targetRef.current = next;
      setTarget(next);
      void Haptics.selectionAsync();
    }
  }, [dragY]);

  const stopTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const finish = useCallback(() => {
    stopTimer();
    dragRef.current = null;
    setDrag(null);
    dragY.value = 0;
  }, [dragY, stopTimer]);

  useEffect(() => stopTimer, [stopTimer]);

  const begin = useCallback(
    (next: ActiveDrag, absoluteY: number) => {
      dragRef.current = next;
      fingerY.current = absoluteY;
      targetRef.current = next.from;
      translation.current = 0;
      startScroll.current = scrollY.current;
      dragY.value = 0;
      setTarget(next.from);
      setDrag(next);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      stopTimer();
      timer.current = setInterval(() => {
        const { top, bottom } = viewport.current;
        const y = fingerY.current;
        let step = 0;
        if (y < top + EDGE) step = -MAX_SCROLL_STEP * Math.min(1, (top + EDGE - y) / EDGE);
        else if (y > bottom - EDGE)
          step = MAX_SCROLL_STEP * Math.min(1, (y - (bottom - EDGE)) / EDGE);
        if (step !== 0) {
          const next = Math.max(0, Math.min(maxScroll.current, scrollY.current + step));
          if (next !== scrollY.current) {
            scrollY.current = next;
            scrollTo(next);
          }
        }
        move();
      }, 16);
    },
    [dragY, move, scrollTo, stopTimer],
  );

  const update = useCallback(
    (dy: number, absoluteY: number) => {
      translation.current = dy;
      fingerY.current = absoluteY;
      move();
    },
    [move],
  );

  const end = useCallback(
    (dy: number) => {
      const current = dragRef.current;
      if (!current) return;
      translation.current = dy;
      move();
      const to = targetRef.current;
      finish();
      if (to !== current.from) current.commit(to);
    },
    [finish, move],
  );

  const cancel = useCallback(() => {
    if (dragRef.current) finish();
  }, [finish]);

  const state = useMemo(() => ({ drag, target, dragY }), [drag, target, dragY]);
  const onScroll = useCallback((y: number) => {
    scrollY.current = y;
  }, []);
  const setViewport = useCallback((top: number, bottom: number) => {
    viewport.current = { top, bottom };
  }, []);
  const setBounds = useCallback((content: number, visible: number) => {
    maxScroll.current = Math.max(0, content - visible);
  }, []);
  const active = drag !== null;
  return useMemo(
    () => ({
      state,
      viewportTop: () => viewport.current.top,
      active,
      begin,
      update,
      end,
      cancel,
      isActive: () => dragRef.current !== null,
      lastTranslation: () => translation.current,
      onScroll,
      setViewport,
      setBounds,
    }),
    [state, active, begin, update, end, cancel, onScroll, setViewport, setBounds],
  );
}

export function DragProvider({ value, children }: { value: DragState; children: ReactNode }) {
  return <DragContext.Provider value={value}>{children}</DragContext.Provider>;
}

/** Whether a cell is lifted, for the list's cell renderer to raise it above the cells after it. */
export function isLifted(state: DragState, cellKey: string | undefined): boolean {
  return !!cellKey && !!state.drag?.blocks[state.drag.from]?.includes(cellKey);
}

/** Heights the list measured for each cell key, read when a drag starts. */
export type Heights = Map<string, number>;

export function Draggable({
  cellKey,
  heights,
  enabled,
  grab,
  onMenu,
  style,
  children,
  testID,
}: {
  cellKey: string;
  heights: Heights;
  /** False while dragging is off, for example during a search. */
  enabled: boolean;
  /** Describes the held block for this cell, or null when it cannot be dragged. */
  grab: () => (Omit<ActiveDrag, "heights" | "blocks"> & { keys: string[][] }) | null;
  /** Long press and release without moving. */
  onMenu?: () => void;
  style?: object;
  children: ReactNode;
  testID?: string;
}) {
  const ctx = useContext(DragContext);
  const list = useContext(ListDragContext);
  const shift = useSharedValue(0);
  const lifted = ctx ? isLifted(ctx, cellKey) : false;
  const target = ctx?.target ?? 0;
  const drag = ctx?.drag ?? null;

  useEffect(() => {
    let next = 0;
    if (drag && !lifted) {
      const at = drag.blocks.findIndex((keys) => keys.includes(cellKey));
      if (at >= 0) next = shiftFor(drag.heights, drag.from, target, at);
    }
    shift.value = withTiming(next, { duration: 160 });
  }, [drag, lifted, target, cellKey, shift]);

  // The held row stays in its cell and is only hidden. Raising it above the cells after it with
  // `zIndex` makes Fabric re-insert the cell, and that cancels the gesture that holds it, so the
  // list draws a copy above itself instead (`DragOverlay`).
  const animated = useAnimatedStyle(() =>
    lifted ? { opacity: 0 } : { opacity: 1, transform: [{ translateY: shift.value }] },
  );
  const box = useRef<View>(null);

  // The handlers read the latest props through a ref, so the gesture's config stays the same
  // object while a drag re-renders the row and the native handler is never rebuilt mid-hold.
  const latest = useRef({ grab, list, heights, onMenu, children });
  latest.current = { grab, list, heights, onMenu, children };
  const holding = useRef(false);
  const handlers = useMemo(() => {
    /** Ends the hold once: a drop, a menu (no movement) or a cancel. Safe to call twice. */
    const release = (translationY: number | null) => {
      // Another cell's touch also reaches these handlers; only the cell that began the hold acts.
      const mine = holding.current;
      holding.current = false;
      const { list: l, onMenu: menu } = latest.current;
      if (!mine || !l?.isActive()) return;
      if (translationY === null) return l.cancel();
      if (Math.abs(translationY) < TAP_SLOP && menu) {
        l.cancel();
        menu();
        return;
      }
      l.end(translationY);
    };
    return {
      onActivate: (event: { absoluteY: number }) => {
        const { grab: g, list: l, heights: h } = latest.current;
        const held = g();
        if (!held || !l) return;
        // Rows the list has not rendered have no measured height; use the average of the others.
        const known = [...h.entries()].filter(([key]) => !key.startsWith("header:"));
        const average = known.length
          ? known.reduce((sum, [, height]) => sum + height, 0) / known.length
          : 54;
        const sizes = held.keys.map((keys) =>
          keys.reduce((sum, key) => sum + (h.get(key) ?? average), 0),
        );
        holding.current = true;
        box.current?.measureInWindow((x, y, width, height) => {
          // The finger may have left before the measurement came back.
          if (!holding.current) return;
          const { list: current, children: node } = latest.current;
          current?.begin(
            {
              from: held.from,
              blocks: held.keys,
              heights: sizes,
              commit: held.commit,
              overlay: { node, x, y: y - current.viewportTop(), width, height },
            },
            event.absoluteY,
          );
        });
      },
      onUpdate: (event: { translationY: number; absoluteY: number }) =>
        latest.current.list?.update(event.translationY, event.absoluteY),
      onDeactivate: (event: { translationY: number; canceled: boolean }) =>
        release(event.canceled ? null : event.translationY),
      onFinalize: (event: { canceled: boolean }) =>
        release(event.canceled ? null : (latest.current.list?.lastTranslation() ?? null)),
      onTouchesUp: () => release(latest.current.list?.lastTranslation() ?? null),
    };
  }, []);

  const gesture = usePanGesture({
    enabled: enabled && list !== null,
    activateAfterLongPress: HOLD_MS,
    runOnJS: true,
    onActivate: handlers.onActivate,
    onUpdate: handlers.onUpdate,
    onDeactivate: handlers.onDeactivate,
    onFinalize: handlers.onFinalize,
    onTouchesUp: handlers.onTouchesUp,
  });

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        ref={box}
        style={[style, animated]}
        testID={testID}
        onLayout={(e) => heights.set(cellKey, e.nativeEvent.layout.height)}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

export const ListDragContext = createContext<ListDrag | null>(null);

/** The copy of the held row that follows the finger, drawn above every cell of the list. */
export function DragOverlay() {
  const ctx = useContext(DragContext);
  const overlay = ctx?.drag?.overlay;
  const dragY = ctx?.dragY;
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: dragY?.value ?? 0 }, { scale: 1.02 }],
  }));
  if (!overlay) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          left: overlay.x,
          top: overlay.y,
          width: overlay.width,
          height: overlay.height,
          shadowColor: "#000", // theme-lint-ignore-line: drop shadow of the lifted row
          shadowOpacity: 0.25,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
        },
        style,
      ]}
    >
      {overlay.node}
    </Animated.View>
  );
}
