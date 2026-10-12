import { Redirect, router, Stack } from "expo-router";
import { useEffect } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { Body, Screen, styles, Title } from "../components/ui";
import { useHubs } from "../lib/hubs-context";
import { resetTo } from "../lib/navigation";
import { colors } from "../theme";

/** Placeholder home: the active hub and whether it answers. The worktree list replaces it. */
export default function Home() {
  const { active, connection, recheck } = useHubs();

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const check = () =>
      void recheck().then((c) => {
        if (!cancelled && c.state === "unreachable") resetTo("/unreachable");
      });
    check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") check();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [active, recheck]);

  if (!active) return <Redirect href="/connect" />;

  const connected = connection.state === "connected";
  return (
    <Screen testID="home__screen">
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => router.push("/hubs")}
              accessibilityRole="button"
              testID="home__hubs"
            >
              <Text style={homeStyles.headerButton}>Hubs</Text>
            </Pressable>
          ),
        }}
      />
      <View style={styles.card}>
        <Title testID="home__hub-name">{active.label}</Title>
        <Body testID="home__hub-url">{active.url}</Body>
        <View style={homeStyles.status}>
          <View
            style={[
              homeStyles.dot,
              { backgroundColor: connected ? colors.success : colors.warning },
            ]}
          />
          <Text style={homeStyles.statusText} testID="home__status">
            {connected ? "Connected" : "Checking…"}
          </Text>
        </View>
      </View>
      <Body>Worktrees and chats will show here.</Body>
    </Screen>
  );
}

const homeStyles = StyleSheet.create({
  headerButton: { color: colors.foreground, fontSize: 17 },
  status: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { color: colors.foreground, fontSize: 15 },
});
