import { Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { restoreAppearance } from "../lib/appearance";
import { HubSessionProvider } from "../lib/hub-session";
import { HubsProvider, useHubs } from "../lib/hubs-context";
import { colors, navigationDark, navigationLight, useScheme } from "../theme";

/** Gives the signed-in screens the active hub's session; the pairing screens ignore it. */
function ActiveHubSession({ children }: { children: ReactNode }) {
  const { active } = useHubs();
  return <HubSessionProvider hub={active}>{children}</HubSessionProvider>;
}

export default function RootLayout() {
  const scheme = useScheme();
  useEffect(() => {
    void restoreAppearance();
  }, []);
  return (
    <SafeAreaProvider>
      <ThemeProvider value={scheme === "light" ? navigationLight : navigationDark}>
        <HubsProvider>
          <ActiveHubSession>
            <StatusBar style={scheme === "light" ? "dark" : "light"} />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.background },
                headerTintColor: colors.foreground,
                contentStyle: { backgroundColor: colors.background },
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="connect" options={{ title: "Band" }} />
              <Stack.Screen name="scan" options={{ title: "Scan QR code" }} />
              <Stack.Screen name="manual" options={{ title: "Enter URL and token" }} />
              <Stack.Screen name="pair" options={{ title: "Pairing" }} />
              <Stack.Screen name="home" options={{ headerShown: false }} />
              <Stack.Screen name="worktree/[id]" options={{ headerShown: false }} />
              <Stack.Screen name="worktree/[id]/explorer" options={{ headerShown: false }} />
              <Stack.Screen name="worktree/[id]/file" options={{ headerShown: false }} />
              <Stack.Screen name="worktree/[id]/changes" options={{ headerShown: false }} />
              <Stack.Screen name="worktree/[id]/diff" options={{ headerShown: false }} />
              <Stack.Screen name="hubs" options={{ title: "Hubs" }} />
              <Stack.Screen
                name="unreachable"
                options={{ title: "Band", headerBackVisible: false }}
              />
            </Stack>
          </ActiveHubSession>
        </HubsProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
