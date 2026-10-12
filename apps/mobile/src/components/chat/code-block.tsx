import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { highlight } from "../../lib/chat/highlight";
import { chatColors, codeColors, colors, fonts } from "../../theme";
import { useChat } from "./chat-context";

/** How long an open fence must stay unchanged before it is highlighted. */
const SETTLE_MS = 400;

/**
 * A fenced code block: the language, a Copy button and the highlighted code, scrolling sideways
 * instead of wrapping. A mermaid fence is labelled "diagram" and math "math"; both show their
 * source until the app draws them.
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  label,
  open,
}: {
  code: string;
  lang: string;
  label?: "diagram" | "math";
  /** No closing fence yet, so it may still be streaming. */
  open?: boolean;
}) {
  const { copy } = useChat();
  // An open fence is highlighted once it stops changing: right away would re-run the highlighter
  // over the whole block on every chunk, never would leave a fence the agent didn't close plain.
  // The text that stayed unchanged for SETTLE_MS. A new chunk differs from it in the same render
  // it arrives in, so it is drawn plain without waiting for an effect.
  const [settledCode, setSettledCode] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setSettledCode(code), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [code, open]);
  const settled = !open || settledCode === code;
  const runs = useMemo(
    () => (settled ? highlight(code, lang) : [{ text: code }]),
    [code, lang, settled],
  );
  return (
    <View style={styles.block} testID="chat__code-block">
      <View style={styles.header}>
        <Text style={styles.lang} testID="chat__code-lang">
          {label ?? (lang || "text")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          hitSlop={8}
          onPress={() => copy(code)}
          testID="chat__code-copy"
        >
          <Text style={styles.copy}>Copy</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.code} testID="chat__code">
          {runs.map((run, i) =>
            run.scope ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity beyond position
              <Text key={i} style={{ color: codeColors[run.scope] ?? colors.foreground }}>
                {run.text}
              </Text>
            ) : (
              run.text
            ),
          )}
        </Text>
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  block: {
    backgroundColor: chatColors.code,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  header: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  lang: { color: colors.mutedForeground, fontFamily: fonts.mono, fontSize: 12 },
  copy: { color: colors.mutedForeground, fontSize: 13 },
  code: {
    color: colors.foreground,
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 19,
    padding: 12,
  },
});
