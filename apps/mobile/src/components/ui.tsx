import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, useScheme } from "../theme";

/** A screen's body: safe-area padded, scrollable so the keyboard never hides a field. */
export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <SafeAreaView style={styles.safe} edges={["bottom", "left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.screen}
        keyboardShouldPersistTaps="handled"
        testID={testID}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Title({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.title} testID={testID} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.body} testID={testID}>
      {children}
    </Text>
  );
}

export function ErrorText({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.error} testID={testID} accessibilityRole="alert">
      {children}
    </Text>
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  busy,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "destructive";
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const primary = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        (pressed || disabled) && styles.buttonDim,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? colors.primaryForeground : colors.foreground} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            primary && styles.buttonTextPrimary,
            variant === "destructive" && styles.buttonTextDestructive,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const scheme = useScheme();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        keyboardAppearance={scheme}
        placeholderTextColor={colors.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        accessibilityLabel={label}
        {...props}
      />
    </View>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

export function Spinner() {
  return <ActivityIndicator color={colors.foreground} />;
}

export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  screen: { padding: 20, gap: 14 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 20,
    backgroundColor: colors.background,
  },
  title: { color: colors.foreground, fontSize: 22, fontWeight: "600" },
  body: { color: colors.mutedForeground, fontSize: 15, lineHeight: 21 },
  error: { color: colors.destructive, fontSize: 15, lineHeight: 21 },
  button: {
    minHeight: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonSecondary: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.muted },
  buttonDim: { opacity: 0.6 },
  buttonText: { color: colors.foreground, fontSize: 16, fontWeight: "500" },
  buttonTextPrimary: { color: colors.primaryForeground },
  buttonTextDestructive: { color: colors.destructive },
  field: { gap: 6 },
  label: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
  input: {
    minHeight: 46,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    color: colors.foreground,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: 16,
    gap: 6,
  },
});
