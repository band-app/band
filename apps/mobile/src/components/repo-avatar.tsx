import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";

/** Up to two letters of a name, for an avatar with no picture. */
export function initials(name: string): string {
  const words = name.split(/[\s\-_/.]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? (words[1]?.[0] ?? "") : "")).toUpperCase();
}

const AVATAR_COLORS = ["#7c3aed", "#0ea5e9", "#16a34a", "#d97706", "#db2777", "#475569"];

export function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? "#475569";
}

/**
 * A repo's icon: the GitHub owner's avatar the hub serves (with the device token), else a colored
 * square with the repo's first letter.
 */
export function RepoAvatar({
  name,
  src,
  base,
  token,
  size = 22,
}: {
  name: string;
  /** The hub path of the avatar (`repos.list` `avatar.src`), if the repo has one. */
  src?: string | null;
  base: string;
  token: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, borderRadius: size * 0.27 };
  if (src?.startsWith("/") && !src.startsWith("//") && !failed) {
    return (
      <Image
        source={{
          uri: `${base.replace(/\/$/, "")}${src}`,
          headers: { Authorization: `Bearer ${token}` },
        }}
        style={box}
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <View style={[styles.letter, box, { backgroundColor: avatarColor(name) }]}>
      <Text style={[styles.letterText, { fontSize: size * 0.55 }]}>
        {initials(name).slice(0, 1)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  letter: { alignItems: "center", justifyContent: "center" },
  letterText: { color: "#fff", fontWeight: "700" },
});
