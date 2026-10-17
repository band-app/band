import type { GestureResponderEvent } from "react-native";
import { Keyboard } from "react-native";

const TAP_MS = 400;
const TAP_SLOP = 10;

/**
 * Touch handlers that close the keyboard after a tap. They only watch the touch: the child that
 * owns it (a link, a button, a long press) still gets it. A long press or a drag does not close the
 * keyboard, so a long-press to copy works with the keyboard open.
 */
export function tapDismiss() {
  let start: { x: number; y: number; t: number } | null = null;
  return {
    onTouchStart: (e: GestureResponderEvent) => {
      const { pageX, pageY } = e.nativeEvent;
      start = { x: pageX, y: pageY, t: Date.now() };
    },
    onTouchEnd: (e: GestureResponderEvent) => {
      const s = start;
      start = null;
      if (!s) return;
      const { pageX, pageY } = e.nativeEvent;
      const moved = Math.hypot(pageX - s.x, pageY - s.y) > TAP_SLOP;
      if (!moved && Date.now() - s.t < TAP_MS) Keyboard.dismiss();
    },
  };
}
