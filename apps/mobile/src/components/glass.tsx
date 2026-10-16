import { BlurView } from "expo-blur";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Plus,
  Search,
} from "lucide-react-native";
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

/** Search, plus and chevron are lucide icons (react-native-svg). The mic and dots are drawn from views. */
export function SearchGlyph({ size = 20 }: { size?: number }) {
  return <Search size={size} color={colors.foreground} />;
}

export function PlusGlyph({
  size = 18,
  color,
}: {
  size?: number;
  color?: ViewStyle["backgroundColor"];
}) {
  return <Plus size={size} color={color ?? colors.foreground} />;
}

/** A microphone drawn from views: a capsule, a cradle and a stand. */
export function MicGlyph({ size = 18 }: { size?: number }) {
  const line = colors.foreground;
  return (
    <View style={{ width: size, height: size, alignItems: "center" }}>
      <View
        style={{
          width: size * 0.38,
          height: size * 0.62,
          borderRadius: size * 0.19,
          backgroundColor: line,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: size * 0.3,
          width: size * 0.66,
          height: size * 0.4,
          borderColor: line,
          borderBottomWidth: 1.6,
          borderLeftWidth: 1.6,
          borderRightWidth: 1.6,
          borderBottomLeftRadius: size * 0.33,
          borderBottomRightRadius: size * 0.33,
        }}
      />
      <View
        style={{
          position: "absolute",
          bottom: size * 0.04,
          width: 1.6,
          height: size * 0.2,
          backgroundColor: line,
        }}
      />
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

const CHEVRONS = {
  down: ChevronDown,
  left: ChevronLeft,
  right: ChevronRight,
  up: ChevronUp,
};

/** The lucide chevron; `size` is the old drawn glyph's edge, so the icon is drawn at twice that. */
export function ChevronGlyph({
  direction,
  size = 9,
  color,
}: {
  direction: "down" | "left" | "right" | "up";
  size?: number;
  color?: ViewStyle["backgroundColor"];
}) {
  const Icon = CHEVRONS[direction];
  return <Icon size={Math.round(size * 2)} color={color ?? colors.mutedForeground} />;
}

export function BackGlyph() {
  return <ChevronGlyph direction="left" size={11} color={colors.foreground} />;
}

export function GlyphText({ children }: { children: string }) {
  return (
    <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>{children}</Text>
  );
}
