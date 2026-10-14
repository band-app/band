import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { colors, floating } from "../theme";

/**
 * A frosted surface: the system material blurred behind a tinted fill, in a hairline border.
 * The shadow sits on an outer view because the blur's clipping would cut it off.
 */
export function Glass({
  children,
  radius = 22,
  style,
  innerStyle,
}: {
  children?: ReactNode;
  radius?: number;
  style?: ViewStyle;
  innerStyle?: ViewStyle;
}) {
  return (
    <View style={[floating, { borderRadius: radius }, style]}>
      <View style={[styles.clip, { borderRadius: radius }, innerStyle]}>
        <BlurView tint="systemMaterial" intensity={50} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.tint]} pointerEvents="none" />
        {children}
      </View>
    </View>
  );
}

/** A 44 pt glass button with one glyph. */
export function GlassCircle({
  children,
  onPress,
  label,
  testID,
}: {
  children: ReactNode;
  onPress: () => void;
  label: string;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      hitSlop={4}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Glass radius={22} style={styles.circle} innerStyle={styles.center}>
        {children}
      </Glass>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  tint: { backgroundColor: colors.glass },
  circle: { width: 44, height: 44 },
  center: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.6 },
});

/** Glyphs drawn from views and text, so the app needs no icon font. */
export function SearchGlyph({ size = 20 }: { size?: number }) {
  const ring = size * 0.68;
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: 2,
          borderColor: colors.foreground,
        }}
      />
      <View
        style={{
          position: "absolute",
          right: size * 0.04,
          bottom: size * 0.12,
          width: size * 0.36,
          height: 2,
          borderRadius: 1,
          backgroundColor: colors.foreground,
          transform: [{ rotate: "45deg" }],
        }}
      />
    </View>
  );
}

export function PlusGlyph({
  size = 18,
  color,
}: {
  size?: number;
  color?: ViewStyle["backgroundColor"];
}) {
  const bar = {
    position: "absolute" as const,
    backgroundColor: color ?? colors.foreground,
    borderRadius: 1,
  };
  return (
    <View style={{ width: size, height: size }}>
      <View style={[bar, { left: 0, right: 0, top: size / 2 - 1, height: 2 }]} />
      <View style={[bar, { top: 0, bottom: 0, left: size / 2 - 1, width: 2 }]} />
    </View>
  );
}

export function DotsGlyph() {
  return (
    <View style={{ flexDirection: "row", gap: 3.5 }}>
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={{
            width: 4.5,
            height: 4.5,
            borderRadius: 2.25,
            backgroundColor: colors.foreground,
          }}
        />
      ))}
    </View>
  );
}

export function ChevronGlyph({
  direction,
  size = 9,
  color,
}: {
  direction: "down" | "left" | "right" | "up";
  size?: number;
  color?: ViewStyle["backgroundColor"];
}) {
  const rotate = { down: "45deg", left: "135deg", up: "225deg", right: "-45deg" }[direction];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRightWidth: 2,
        borderBottomWidth: 2,
        borderColor: color ?? colors.mutedForeground,
        transform: [{ rotate }],
      }}
    />
  );
}

export function BackGlyph() {
  return <ChevronGlyph direction="left" size={11} color={colors.foreground} />;
}

export function GlyphText({ children }: { children: string }) {
  return (
    <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>{children}</Text>
  );
}
