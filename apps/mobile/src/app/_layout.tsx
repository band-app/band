import { Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HubSessionProvider } from "../lib/hub-session";
import { HubsProvider, useHubs } from "../lib/hubs-context";
import { colors, navigationTheme } from "../theme";

/** Gives the signed-in screens the active hub's session; the pairing screens ignore it. */
function ActiveHubSession({ children }: { children: ReactNode }) {
  const { active } = useHubs();
  return <HubSessionProvider hub={active}>{children}</HubSessionProvider>;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider value={navigationTheme}>
        <HubsProvider>
          <ActiveHubSession>
            <StatusBar style="light" />
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
              <Stack.Screen name="home" options={{ title: "Band" }} />
              <Stack.Screen name="worktree/[id]" options={{ title: "Worktree" }} />
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
