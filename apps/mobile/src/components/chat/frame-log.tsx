import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";

import { fonts } from "../../theme";

/** A gap between two JS frames longer than this is a stall. */
const STALL_MS = 100;

/**
 * JS thread frame log for performance runs. Built in only when the app is built with
 * `EXPO_PUBLIC_BAND_PERF_LOG=1` (mobile-verify's perf run): it times the gaps between
 * `requestAnimationFrame` callbacks, which can only run when the JS thread is free, and shows
 * the longest gap and how many passed 100 ms. Tapping it starts a new measurement.
 */
export function FrameLog() {
  const [stats, setStats] = useState({ max: 0, stalls: 0, frames: 0 });
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    void epoch;
    let last = 0;
    let max = 0;
    let stalls = 0;
    let frames = 0;
    let handle = 0;
    const tick = (now: number) => {
      if (last > 0) {
        const gap = now - last;
        frames++;
        if (gap > max) max = gap;
        if (gap > STALL_MS) stalls++;
      }
      last = now;
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    const timer = setInterval(() => setStats({ max: Math.round(max), stalls, frames }), 500);
    return () => {
      cancelAnimationFrame(handle);
      clearInterval(timer);
    };
  }, [epoch]);

  return (
    <Pressable
      accessible={false}
      onPress={() => setEpoch((n) => n + 1)}
      style={styles.box}
      testID="perf__frame-log"
    >
      <Text style={styles.text} testID="perf__frame-log-text">
        {`max ${stats.max}ms stalls>${STALL_MS}ms ${stats.stalls} frames ${stats.frames}`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: 4,
    left: 8,
    paddingHorizontal: 6,
    paddingVertical: 3,
    position: "absolute",
    top: 8,
  },
  text: { color: "#4ade80", fontFamily: fonts.mono, fontSize: 11 },
});
