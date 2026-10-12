import { Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HubsProvider } from "../lib/hubs-context";
import { colors, navigationTheme } from "../theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider value={navigationTheme}>
        <HubsProvider>
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
            <Stack.Screen name="hubs" options={{ title: "Hubs" }} />
            <Stack.Screen
              name="unreachable"
              options={{ title: "Band", headerBackVisible: false }}
            />
          </Stack>
        </HubsProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
