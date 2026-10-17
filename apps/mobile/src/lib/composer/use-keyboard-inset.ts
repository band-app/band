import { useKeyboardHandler } from "react-native-keyboard-controller";
import {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// iOS's keyboard curve, close enough for the frames the keyboard does not report.
const KEYBOARD_EASING = Easing.bezier(0.17, 0.59, 0.4, 0.77);

/**
 * The space under the composer: the keyboard's height while it is open, the home indicator's
 * inset otherwise. `react-native-keyboard-controller` reports the keyboard's own frames on the UI
 * thread, so the style moves the composer with the keyboard in every frame, with no JS round trip
 * and no gap, also while the JS thread is busy rendering a stream.
 * The first time the keyboard opens in a session, iOS reports no frames. The inset then runs the
 * keyboard's duration on its own curve from the start event, instead of jumping to the end.
 * The screen's content ends at the screen's bottom edge, so the keyboard's height is the whole offset.
 */
export function useKeyboardInset() {
  const { bottom } = useSafeAreaInsets();
  const inset = useSharedValue(bottom);
  const bottomEdge = useSharedValue(bottom);
  bottomEdge.value = bottom;

  useKeyboardHandler(
    {
      onStart: (e) => {
        "worklet";
        inset.value = withTiming(Math.max(e.height, bottomEdge.value), {
          duration: e.duration || 250,
          easing: KEYBOARD_EASING,
        });
      },
      onMove: (e) => {
        "worklet";
        // Real frames win over the stand-in curve.
        cancelAnimation(inset);
        inset.value = Math.max(e.height, bottomEdge.value);
      },
      onEnd: (e) => {
        "worklet";
        cancelAnimation(inset);
        inset.value = Math.max(e.height, bottomEdge.value);
      },
    },
    [],
  );

  return useAnimatedStyle(() => ({ paddingBottom: inset.value }));
}
