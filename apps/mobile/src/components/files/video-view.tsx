import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { StyleSheet, Text, View } from "react-native";
import { baseName } from "../../lib/files/paths";
import { colors } from "../../theme";

/**
 * A worktree video from the hub, with the system's playback controls. The hub answers Range
 * requests, so seeking works. The player sends the Bearer token as a header, never in the URL.
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
  const player = useVideoPlayer({ uri, headers: { Authorization: `Bearer ${token}` } });
  const { status } = useEvent(player, "statusChange", { status: player.status });

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
        player={player}
        style={styles.fill}
        nativeControls
        contentFit="contain"
        accessibilityLabel={baseName(path)}
        testID="file__video"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { backgroundColor: "#000", flex: 1 },
  center: { alignItems: "center", flex: 1, gap: 8, justifyContent: "center", padding: 24 },
  title: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
  text: { color: colors.mutedForeground, fontSize: 14 },
});
