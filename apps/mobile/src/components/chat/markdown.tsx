import { memo, type ReactNode, useMemo } from "react";
import { Linking, ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native";
import {
  type Align,
  type Block,
  type ListItem,
  parseMarkdown,
  type Span,
  spansText,
} from "../../lib/chat/markdown";
import { chatColors, colors, fonts } from "../../theme";
import { useChat } from "./chat-context";
import { CodeBlock } from "./code-block";

/** Agent or user markdown as native text. Parsed again only when the text changes. */
export const Markdown = memo(function Markdown({ text, muted }: { text: string; muted?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={styles.stack}>
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity beyond position, and a streamed message only grows at the end
        <BlockView key={i} block={block} muted={muted} />
      ))}
    </View>
  );
});

function Spans({ spans }: { spans: readonly Span[] }) {
  const { openFile } = useChat();
  return spans.map((span, i) => {
    const style: TextStyle[] = [];
    if (span.bold) style.push(styles.bold);
    if (span.italic) style.push(styles.italic);
    if (span.strike) style.push(styles.strike);
    if (span.code) style.push(styles.inlineCode);
    const link = span.link;
    if (link) style.push(styles.link);
    const onPress = !link
      ? undefined
      : "file" in link
        ? () => openFile(link.file)
        : () => void Linking.openURL(link.url).catch(() => {});
    if (style.length === 0 && !onPress) return span.text;
    return (
      <Text
        // biome-ignore lint/suspicious/noArrayIndexKey: spans have no identity beyond position
        key={i}
        style={style}
        onPress={onPress}
        accessibilityRole={link ? "link" : undefined}
      >
        {span.text}
      </Text>
    );
  });
}

function Paragraph({ spans, style }: { spans: readonly Span[]; style?: TextStyle | TextStyle[] }) {
  return (
    <Text style={[styles.text, style]}>
      <Spans spans={spans} />
    </Text>
  );
}

const HEADING_SIZES = [24, 21, 19, 17, 16, 16];

function ListView({
  ordered,
  start,
  items,
  muted,
}: {
  ordered: boolean;
  start: number;
  items: ListItem[];
  muted?: boolean;
}) {
  return (
    <View style={styles.list}>
      {items.map((item, i) => {
        const marker =
          item.checked !== undefined ? (item.checked ? "☑" : "☐") : ordered ? `${start + i}.` : "•";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond position
          <View key={i} style={styles.listItem}>
            <Text style={[styles.text, styles.marker]}>{marker}</Text>
            <View style={styles.listBody}>
              {item.blocks.map((block, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity beyond position
                <BlockView key={j} block={block} muted={muted} />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** A column's width from its longest cell, so the table scrolls sideways instead of squeezing. */
function columnWidths(header: Span[][], rows: Span[][][]): number[] {
  return header.map((cell, c) => {
    const longest = Math.max(
      spansText(cell).length,
      ...rows.map((row) => (row[c] ? spansText(row[c]).length : 0)),
    );
    return Math.min(260, Math.max(64, longest * 8 + 20));
  });
}

function TableView({
  align,
  header,
  rows,
}: {
  align: Align[];
  header: Span[][];
  rows: Span[][][];
}) {
  const widths = useMemo(() => columnWidths(header, rows), [header, rows]);
  const cell = (spans: Span[] | undefined, c: number, head: boolean): ReactNode => (
    <View key={c} style={[styles.cell, { width: widths[c] }]}>
      <Paragraph
        spans={spans ?? []}
        style={[styles.cellText, ...(head ? [styles.bold] : []), { textAlign: align[c] ?? "left" }]}
      />
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="chat__table">
      <View style={styles.table}>
        <View style={[styles.row, styles.headRow]}>{header.map((h, c) => cell(h, c, true))}</View>
        {rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond position
          <View key={r} style={styles.row}>
            {header.map((_, c) => cell(row[c], c, false))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function BlockView({ block, muted }: { block: Block; muted?: boolean }) {
  const tone = muted ? styles.muted : undefined;
  switch (block.type) {
    case "heading":
      return (
        <Paragraph
          spans={block.spans}
          style={[
            styles.heading,
            { fontSize: HEADING_SIZES[block.depth - 1] ?? 16 },
            ...(tone ? [tone] : []),
          ]}
        />
      );
    case "paragraph":
      return <Paragraph spans={block.spans} style={tone} />;
    case "code":
      return <CodeBlock code={block.text} lang={block.lang} label={block.label} />;
    case "list":
      return (
        <ListView ordered={block.ordered} start={block.start} items={block.items} muted={muted} />
      );
    case "quote":
      return (
        <View style={styles.quote}>
          {block.blocks.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity beyond position
            <BlockView key={i} block={b} muted />
          ))}
        </View>
      );
    case "table":
      return <TableView align={block.align} header={block.header} rows={block.rows} />;
    case "rule":
      return <View style={styles.rule} />;
  }
}

const styles = StyleSheet.create({
  stack: { gap: 10 },
  text: { color: colors.foreground, fontSize: 16, lineHeight: 23 },
  muted: { color: colors.mutedForeground },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  inlineCode: {
    backgroundColor: chatColors.inlineCode,
    fontFamily: fonts.mono,
    fontSize: 14,
  },
  link: { color: chatColors.link },
  heading: { fontWeight: "700", lineHeight: 28 },
  list: { gap: 4 },
  listItem: { flexDirection: "row", gap: 8 },
  marker: { minWidth: 18, textAlign: "right", color: colors.mutedForeground },
  listBody: { flex: 1, gap: 6 },
  quote: {
    borderLeftColor: colors.border,
    borderLeftWidth: 3,
    gap: 8,
    paddingLeft: 12,
  },
  table: {
    borderColor: colors.border,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
  },
  headRow: { backgroundColor: colors.muted, borderTopWidth: 0 },
  cell: { paddingHorizontal: 10, paddingVertical: 6 },
  cellText: { fontSize: 14, lineHeight: 20 },
  rule: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
});
