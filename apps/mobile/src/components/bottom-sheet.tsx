import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Dimensions,
  type GestureResponderEvent,
  Modal,
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors } from "../theme";

const DURATION = 240;
const CLOSE_DISTANCE = 60;
const CLOSE_VELOCITY = 0.8;

/**
 * A custom bottom sheet: the dim backdrop fades in where it is and the panel slides up from the
 * bottom, and closing runs the same two animations backwards. Tapping the backdrop, swiping the
 * panel down and the system back gesture call `onClose`. With reduced motion the panel does not
 * slide and only the backdrop fades. The panel pads its own bottom edge through `style`.
 */
export function BottomSheet({
  visible,
  onClose,
  onDismiss,
  children,
  style,
  testID,
  backdropTestID,
  backdropLabel = "Close",
  accessibilityLabel,
}: {
  visible: boolean;
  onClose: () => void;
  /** The modal is fully gone, so a system picker can open without clashing with it. */
  onDismiss?: () => void;
  children: ReactNode;
  /** The panel's own look: padding, radius, max height. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
  backdropTestID?: string;
  backdropLabel?: string;
  accessibilityLabel?: string;
}) {
  const reduceMotion = useReducedMotion();
  const bottomInset = useSafeAreaInsets().bottom;
  const flat: ViewStyle = StyleSheet.flatten([styles.sheet, style]);
  const padding = flat.paddingBottom;
  const gap = flat.gap;
  const paddingBottom = Math.max(typeof padding === "number" ? padding : 0, bottomInset);
  const [shown, setShown] = useState(visible);
  const progress = useSharedValue(0);
  const drag = useSharedValue(0);
  const height = useSharedValue(Dimensions.get("window").height);

  useEffect(() => {
    const easing = Easing.bezier(0.32, 0.72, 0, 1);
    if (visible) {
      setShown(true);
      drag.value = 0;
      progress.value = withTiming(1, { duration: DURATION, easing });
      return;
    }
    progress.value = withTiming(0, { duration: DURATION, easing });
    const timer = setTimeout(() => {
      setShown(false);
      drag.value = 0;
    }, DURATION);
    return () => clearTimeout(timer);
  }, [visible, progress, drag]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Plain touch handlers, not a PanResponder: they see the touches of every child, a button or
  // a list included, with no responder to win first.
  const touch = useRef({ y: 0, t: 0, dragging: false });
  const settle = () => {
    touch.current.dragging = false;
    drag.value = withTiming(0, { duration: 160 });
  };
  const touchHandlers = {
    onTouchStart: (e: GestureResponderEvent) => {
      touch.current = { y: e.nativeEvent.pageY, t: e.nativeEvent.timestamp, dragging: false };
    },
    onTouchMove: (e: GestureResponderEvent) => {
      const dy = e.nativeEvent.pageY - touch.current.y;
      if (dy > 6) touch.current.dragging = true;
      if (touch.current.dragging) drag.value = Math.max(0, dy);
    },
    onTouchEnd: (e: GestureResponderEvent) => {
      if (!touch.current.dragging) return;
      const dy = e.nativeEvent.pageY - touch.current.y;
      const seconds = Math.max((e.nativeEvent.timestamp - touch.current.t) / 1000, 0.001);
      touch.current.dragging = false;
      if (dy > CLOSE_DISTANCE || dy / seconds / 1000 > CLOSE_VELOCITY) onCloseRef.current();
      else settle();
    },
    // The system took the touch (a call, a notification): settle back instead of staying half open.
    onTouchCancel: settle,
  };
  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const panelStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? progress.value : 1,
    transform: [
      { translateY: (reduceMotion ? 0 : (1 - progress.value) * height.value) + drag.value },
    ],
  }));

  return (
    <Modal
      visible={shown}
      transparent
      animationType="none"
      onRequestClose={onClose}
      onDismiss={onDismiss}
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]} pointerEvents="box-none">
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={backdropLabel}
            testID={backdropTestID}
          />
        </Animated.View>
        <Animated.View
          style={[styles.sheet, style, { paddingBottom }, panelStyle]}
          onLayout={(e) => {
            height.value = e.nativeEvent.layout.height;
          }}
          accessibilityLabel={accessibilityLabel}
          testID={testID}
        >
          {/* A plain View takes the swipe: the responder props sit on a native View, not on the animated one. */}
          <View style={[styles.touch, { gap }]} {...touchHandlers}>
            <View style={styles.grab} />
            {children}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: 34,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  touch: { flexShrink: 1 },
  grab: {
    alignSelf: "center",
    backgroundColor: colors.grab,
    borderRadius: 3,
    height: 5,
    marginBottom: 12,
    width: 38,
  },
});
