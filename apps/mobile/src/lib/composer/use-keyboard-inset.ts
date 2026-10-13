import { useEffect, useRef } from "react";
import { Animated, Keyboard, type KeyboardEvent, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * The space under the composer: the keyboard's height while it is open, the home indicator's
 * inset otherwise. It animates with the keyboard (same duration), so the composer rises with it.
 * The screen's content ends at the screen's bottom edge, so the keyboard's height is the whole offset.
 */
export function useKeyboardInset(): { inset: Animated.Value; open: React.RefObject<boolean> } {
  const { bottom } = useSafeAreaInsets();
  const inset = useRef(new Animated.Value(bottom)).current;
  const open = useRef(false);
  const bottomRef = useRef(bottom);
  bottomRef.current = bottom;

  useEffect(() => {
    const move = (to: number, duration: number) =>
      Animated.timing(inset, { toValue: to, duration, useNativeDriver: false }).start();
    const show = (e: KeyboardEvent) => {
      open.current = true;
      move(e.endCoordinates.height, e.duration ?? 250);
    };
    const hide = (e: KeyboardEvent) => {
      open.current = false;
      move(bottomRef.current, e.duration ?? 250);
    };
    const subs =
      Platform.OS === "ios"
        ? [
            Keyboard.addListener("keyboardWillShow", show),
            Keyboard.addListener("keyboardWillChangeFrame", (e) =>
              e.endCoordinates.height > 0 ? show(e) : hide(e),
            ),
            Keyboard.addListener("keyboardWillHide", hide),
          ]
        : [
            Keyboard.addListener("keyboardDidShow", show),
            Keyboard.addListener("keyboardDidHide", hide),
          ];
    return () => {
      for (const sub of subs) sub.remove();
    };
  }, [inset]);

  // Without the keyboard, follow the safe area (rotation, or the first measurement).
  useEffect(() => {
    if (!open.current) inset.setValue(bottom);
  }, [bottom, inset]);

  return { inset, open };
}
