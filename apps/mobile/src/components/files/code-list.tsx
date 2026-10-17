import { FlashList } from "@shopify/flash-list";
import { memo, type ReactElement, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";

import { type CodeRun, highlight } from "../../lib/chat/highlight";
import { chatColors, codeColors, colors, fonts } from "../../theme";

/** One line of the list: a file's line, or a diff's line or hunk header. */
export interface CodeRow {
  key: string;
  text: string;
  /** Highlighted pieces of `text`. Without them, and with `language`, the row highlights itself. */
  runs?: readonly CodeRun[];
  /** Line numbers in the gutter, one entry per column. */
  gutter?: readonly string[];
  tone?: "add" | "del" | "hunk" | "note" | "focus";
}

const FONT_SIZE = 13;
const CHAR_WIDTH = 7.85;
const LINE_HEIGHT = 19;
const GUTTER_PAD = 10;
const SIDE_PAD = 10;
/** A line longer than this is cut, so one minified bundle can't build a million-glyph view. */
export const MAX_LINE_CHARS = 2_000;

/** What a row shows of `text`: tabs as spaces, and a cut for a very long line. */
export function displayText(text: string): string {
  const expanded = text.includes("\t") ? text.replaceAll("\t", "    ") : text;
  return expanded.length > MAX_LINE_CHARS ? `${expanded.slice(0, MAX_LINE_CHARS)}…` : expanded;
}

const TONE_BG = {
  add: chatColors.added,
  del: chatColors.removed,
  hunk: chatColors.code,
  focus: "rgba(59,130,246,0.22)",
} as const;

/**
 * Lines of code in a virtualized list, with a gutter of line numbers and a sideways scroll for
 * long lines. Text is selectable per line. `focusLine` (0-based) scrolls to a row and marks it.
 */
export function CodeList({
  rows,
  language,
  gutterColumns = 1,
  initialIndex,
  onRefresh,
  refreshing,
  testID,
  listHeader,
}: {
  rows: readonly CodeRow[];
  language?: string;
  gutterColumns?: number;
  initialIndex?: number;
  onRefresh?: () => void;
  refreshing?: boolean;
  testID: string;
  listHeader?: ReactElement | null;
}) {
  const { width: screen } = useWindowDimensions();
  const [height, setHeight] = useState(0);
  const gutterChars = useMemo(() => {
    let max = 1;
    for (const row of rows) for (const g of row.gutter ?? []) if (g.length > max) max = g.length;
    return max;
  }, [rows]);
  const columnWidth = gutterChars * CHAR_WIDTH + GUTTER_PAD;
  const gutterWidth = gutterColumns * columnWidth;
  const longest = useMemo(() => {
    let max = 0;
    for (const row of rows) {
      const n = Math.min(
        row.text.length + (row.text.includes("\t") ? 3 * 4 : 0),
        MAX_LINE_CHARS + 1,
      );
      if (n > max) max = n;
    }
    return max;
  }, [rows]);
  const contentWidth = Math.max(screen, gutterWidth + SIDE_PAD * 2 + longest * CHAR_WIDTH);
  return (
    <ScrollView
      horizontal
      style={styles.fill}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      testID={`${testID}-scroll`}
    >
      {height > 0 ? (
        <FlashList
          data={rows as CodeRow[]}
          style={{ width: contentWidth, height }}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.tone ?? "line"}
          initialScrollIndex={initialIndex}
          onRefresh={onRefresh}
          refreshing={refreshing}
          ListHeaderComponent={listHeader}
          renderItem={({ item }) => (
            <CodeLine
              row={item}
              language={language}
              columns={gutterColumns}
              columnWidth={columnWidth}
              width={contentWidth}
            />
          )}
          testID={testID}
        />
      ) : null}
    </ScrollView>
  );
}

const CodeLine = memo(function CodeLine({
  row,
  language,
  columns,
  columnWidth,
  width,
}: {
  row: CodeRow;
  language?: string;
  columns: number;
  columnWidth: number;
  width: number;
}) {
  const runs = useMemo(() => {
    if (row.runs) return row.runs;
    if (language && row.tone !== "hunk" && row.tone !== "note" && row.text) {
      return highlight(row.text, language);
    }
    return null;
  }, [row.runs, row.text, row.tone, language]);
  const bg = row.tone && row.tone !== "note" ? TONE_BG[row.tone] : undefined;
  return (
    <View style={[styles.line, { width }, bg ? { backgroundColor: bg } : null]}>
      {Array.from({ length: columns }, (_, i) => (
        <Text
          // oxlint-disable-next-line react/no-array-index-key -- gutter columns are positional
          key={i}
          style={[styles.gutter, { width: columnWidth }]}
          numberOfLines={1}
        >
          {row.gutter?.[i] ?? ""}
        </Text>
      ))}
      <Text
        selectable
        style={[
          styles.code,
          row.tone === "hunk" && styles.hunk,
          row.tone === "note" && styles.note,
        ]}
        numberOfLines={1}
      >
        {runs
          ? runs.map((run, i) =>
              run.scope ? (
                // oxlint-disable-next-line react/no-array-index-key -- runs have no identity beyond position
                <Text key={i} style={{ color: codeColors[run.scope] ?? colors.foreground }}>
                  {displayText(run.text)}
                </Text>
              ) : (
                displayText(run.text)
              ),
            )
          : displayText(row.text)}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  line: { flexDirection: "row", height: LINE_HEIGHT, paddingRight: SIDE_PAD },
  gutter: {
    color: colors.faint,
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: LINE_HEIGHT,
    paddingLeft: 4,
    paddingRight: 6,
    textAlign: "right",
  },
  code: {
    color: colors.foreground,
    fontFamily: fonts.mono,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    paddingLeft: SIDE_PAD - 4,
  },
  hunk: { color: colors.mutedForeground },
  note: { color: colors.faint, fontStyle: "italic" },
});
