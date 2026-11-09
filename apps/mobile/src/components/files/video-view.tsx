import { useEvent, useEventListener } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { Maximize, Pause, Play, RotateCcw, RotateCw } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { baseName } from "../../lib/files/paths";
import { formatVideoTime, positionFromTouch, skipTime } from "../../lib/files/video-time";
import { colors } from "../../theme";
import { Icon } from "../icon";

const HIDE_AFTER_MS = 3000;
const SKIP_SECONDS = 10;
const OVERLAY = "rgba(0,0,0,0.55)";
const OVERLAY_TEXT = "#fff";

/**
 * A worktree video from the hub with the app's own controls drawn over the picture, so they work
 * whether or not AVKit's inline controls receive a tap. Full screen hands over to the system player,
 * whose controls are native. The hub answers Range requests, so seeking works. The player sends
 * the Bearer token as a header, never in the URL.
 */
export function VideoPlayer({
  hubUrl,
  token,
  worktreeId,
  path,
}: {
  hubUrl: string;
  token: string;
  worktreeId: string;
  path: string;
}) {
  const uri = `${hubUrl}/api/worktree-file/${encodeURIComponent(worktreeId)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const player = useVideoPlayer({ uri, headers: { Authorization: `Bearer ${token}` } }, (p) => {
    p.timeUpdateEventInterval = 0.25;
  });
  const viewRef = useRef<VideoView>(null);
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(player.duration > 0 ? player.duration : 0);
  const [visible, setVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEventListener(player, "timeUpdate", (e) => {
    if (!scrubbing) setTime(e.currentTime);
  });
  useEventListener(player, "sourceLoad", (e) => {
    if (e.duration > 0) setDuration(e.duration);
  });
  useEffect(() => {
    if (status === "readyToPlay" && player.duration > 0) setDuration(player.duration);
  }, [status, player]);

  const clearHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);
  // Controls show on open and on a tap, and hide after 3 s of playback without a touch.
  const show = useCallback(() => {
    setVisible(true);
    clearHide();
    if (player.playing) hideTimer.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
  }, [clearHide, player]);
  useEffect(() => {
    if (isPlaying && !scrubbing) show();
    else {
      clearHide();
      if (!isPlaying) setVisible(true);
    }
  }, [isPlaying, scrubbing, show, clearHide]);
  useEffect(
    () => () => {
      clearHide();
      player.pause();
    },
    [clearHide, player],
  );

  const toggle = () => {
    if (player.playing) player.pause();
    else player.play();
    show();
  };
  const skip = (delta: number) => {
    const next = skipTime(player.currentTime, delta, duration);
    player.currentTime = next;
    setTime(next);
    show();
  };

  if (status === "error") {
    return (
      <View style={styles.center} testID="file__unavailable">
        <Text style={styles.title}>Can't preview this file</Text>
        <Text style={styles.text}>The video didn't load.</Text>
      </View>
    );
  }
  return (
    <View style={styles.fill}>
      <VideoView
        ref={viewRef}
        player={player}
        style={styles.fill}
        nativeControls={false}
        fullscreenOptions={{ enable: true }}
        allowsVideoFrameAnalysis={false}
        contentFit="contain"
        accessibilityLabel={baseName(path)}
        testID="file__video"
        pointerEvents="none"
      />
      {/* This view owns the tap, so nothing native can swallow it. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={show}
        accessible={false}
        testID="file__video-surface"
      />
      {visible ? (
        <View style={styles.controls} pointerEvents="box-none">
          <View style={styles.middle} pointerEvents="box-none">
            <Pressable
              onPress={() => skip(-SKIP_SECONDS)}
              accessibilityRole="button"
              accessibilityLabel="Skip back 10 seconds"
              testID="file__video-back"
              style={styles.side}
              hitSlop={8}
            >
              <Icon icon={RotateCcw} size="lg" color={OVERLAY_TEXT} />
            </Pressable>
            <Pressable
              onPress={toggle}
              accessibilityRole="button"
              accessibilityLabel={isPlaying ? "Pause" : "Play"}
              testID="file__video-play"
              style={styles.play}
            >
              <Icon icon={isPlaying ? Pause : Play} size="lg" color={OVERLAY_TEXT} />
            </Pressable>
            <Pressable
              onPress={() => skip(SKIP_SECONDS)}
              accessibilityRole="button"
              accessibilityLabel="Skip forward 10 seconds"
              testID="file__video-forward"
              style={styles.side}
              hitSlop={8}
            >
              <Icon icon={RotateCw} size="lg" color={OVERLAY_TEXT} />
            </Pressable>
          </View>
          <View style={styles.bar}>
            <Text
              style={styles.time}
              testID="file__video-time"
              accessibilityLabel={formatVideoTime(time)}
            >
              {formatVideoTime(time)}
            </Text>
            <Scrubber
              time={time}
              duration={duration}
              onScrub={(t) => {
                setScrubbing(true);
                setTime(t);
              }}
              onCommit={(t) => {
                player.currentTime = t;
                setTime(t);
                setScrubbing(false);
              }}
              onAdjust={(t) => {
                player.currentTime = t;
                setTime(t);
                show();
              }}
            />
            <Text style={styles.time} testID="file__video-duration">
              {formatVideoTime(duration)}
            </Text>
            <Pressable
              onPress={() => {
                viewRef.current?.enterFullscreen();
                show();
              }}
              accessibilityRole="button"
              accessibilityLabel="Full screen"
              testID="file__video-fullscreen"
              hitSlop={8}
            >
              <Icon icon={Maximize} size="md" color={OVERLAY_TEXT} />
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Scrubber({
  time,
  duration,
  onScrub,
  onCommit,
  onAdjust,
}: {
  time: number;
  duration: number;
  onScrub: (t: number) => void;
  onCommit: (t: number) => void;
  onAdjust: (t: number) => void;
}) {
  const width = useRef(0);
  const latest = useRef({ duration, onScrub, onCommit });
  latest.current = { duration, onScrub, onCommit };
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) =>
          latest.current.onScrub(
            positionFromTouch(e.nativeEvent.locationX, width.current, latest.current.duration),
          ),
        onPanResponderMove: (e) =>
          latest.current.onScrub(
            positionFromTouch(e.nativeEvent.locationX, width.current, latest.current.duration),
          ),
        onPanResponderRelease: (e) =>
          latest.current.onCommit(
            positionFromTouch(e.nativeEvent.locationX, width.current, latest.current.duration),
          ),
        onPanResponderTerminate: (e) =>
          latest.current.onCommit(
            positionFromTouch(e.nativeEvent.locationX, width.current, latest.current.duration),
          ),
      }),
    [],
  );
  const fraction = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
  const step = Math.max(1, duration / 20);
  return (
    <View
      style={styles.track}
      onLayout={(e: LayoutChangeEvent) => {
        width.current = e.nativeEvent.layout.width;
      }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Seek"
      accessibilityValue={{
        min: 0,
        max: Math.round(duration),
        now: Math.round(time),
        text: formatVideoTime(time),
      }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e: AccessibilityActionEvent) =>
        onAdjust(skipTime(time, e.nativeEvent.actionName === "increment" ? step : -step, duration))
      }
      testID="file__video-scrubber"
      {...pan.panHandlers}
    >
      <View style={styles.rail} pointerEvents="none">
        <View style={[styles.fillBar, { width: `${fraction * 100}%` }]} />
      </View>
      <View style={[styles.thumb, { left: `${fraction * 100}%` }]} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { backgroundColor: "#000", flex: 1 },
  controls: {
    bottom: 0,
    justifyContent: "space-between",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  middle: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 36,
    justifyContent: "center",
  },
  play: {
    alignItems: "center",
    backgroundColor: OVERLAY,
    borderRadius: 36,
    height: 72,
    justifyContent: "center",
    width: 72,
  },
  side: {
    alignItems: "center",
    backgroundColor: OVERLAY,
    borderRadius: 24,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  bar: {
    alignItems: "center",
    backgroundColor: OVERLAY,
    flexDirection: "row",
    gap: 10,
    paddingBottom: 16,
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  time: { color: OVERLAY_TEXT, fontSize: 13, fontVariant: ["tabular-nums"], minWidth: 38 },
  track: { flex: 1, height: 36, justifyContent: "center" },
  rail: {
    backgroundColor: "rgba(255,255,255,0.3)",
    borderRadius: 2,
    height: 4,
    overflow: "hidden",
  },
  fillBar: { backgroundColor: OVERLAY_TEXT, height: 4 },
  thumb: {
    backgroundColor: OVERLAY_TEXT,
    borderRadius: 7,
    height: 14,
    marginLeft: -7,
    position: "absolute",
    width: 14,
  },
  center: { alignItems: "center", flex: 1, gap: 8, justifyContent: "center", padding: 24 },
  title: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
  text: { color: colors.mutedForeground, fontSize: 14 },
});
