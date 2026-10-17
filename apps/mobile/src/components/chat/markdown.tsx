import { Square, SquareCheck } from "lucide-react-native";
import { type ComponentProps, memo, type ReactNode, useMemo } from "react";
import { Linking, ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native";
import { UITextView } from "react-native-uitextview";

import {
  type Align,
  type Block,
  type ListItem,
  parseMarkdown,
  type Span,
  spansText,
} from "../../lib/chat/markdown";
import { chatColors, colors, fonts } from "../../theme";
import { Icon } from "../icon";
import { useChat } from "./chat-context";
import { CodeBlock } from "./code-block";

/** Markdown text a person can select by range: a `UITextView` on iOS, plain `Text` elsewhere. */
function SelectableText(props: ComponentProps<typeof UITextView>) {
  return <UITextView selectable uiTextView {...props} />;
}

/** Agent or user markdown as native text. Parsed again only when the text changes. */
export const Markdown = memo(function Markdown({ text, muted }: { text: string; muted?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={styles.stack}>
      {blocks.map((block, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- blocks have no identity beyond position, and a streamed message only grows at the end
        <BlockView key={i} block={block} muted={muted} />
      ))}
    </View>
  );
});

/**
 * A plain function, not a component: `UITextView` turns only its direct string children into
 * native text, so the spans must be its children and not a wrapper element.
 */
function renderSpans(
  spans: readonly Span[],
  openFile: (path: string) => void,
  Leaf: typeof SelectableText | typeof Text,
) {
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
      <Leaf
        // oxlint-disable-next-line react/no-array-index-key -- spans have no identity beyond position
        key={i}
        style={style}
        onPress={onPress}
        accessibilityRole={link ? "link" : undefined}
      >
        {span.text}
      </Leaf>
    );
  });
}

/**
 * Table cells pass `selectable: false`: a `UITextView` under the finger takes the horizontal drag
 * from the table's `ScrollView`, so a cell is plain `Text` and the table scrolls from any point.
 */
function Paragraph({
  spans,
  style,
  selectable = true,
}: {
  spans: readonly Span[];
  style?: TextStyle | TextStyle[];
  selectable?: boolean;
}) {
  const { openFile } = useChat();
  if (!selectable) {
    return <Text style={[styles.text, style]}>{renderSpans(spans, openFile, Text)}</Text>;
  }
  return (
    <SelectableText style={[styles.text, style]}>
      {renderSpans(spans, openFile, SelectableText)}
    </SelectableText>
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
          item.checked !== undefined ? (
            <Icon
              icon={item.checked ? SquareCheck : Square}
              size="sm"
              color={colors.mutedForeground}
            />
          ) : (
            <Text style={[styles.text, styles.marker]}>{ordered ? `${start + i}.` : "•"}</Text>
          );
        return (
          // oxlint-disable-next-line react/no-array-index-key -- list items have no identity beyond position
          <View key={i} style={styles.listItem}>
            <View style={styles.markerBox}>{marker}</View>
            <View style={styles.listBody}>
              {item.blocks.map((block, j) => (
                // oxlint-disable-next-line react/no-array-index-key -- blocks have no identity beyond position
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
        selectable={false}
        style={[styles.cellText, ...(head ? [styles.bold] : []), { textAlign: align[c] ?? "left" }]}
      />
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="chat__table">
      <View style={styles.table}>
        <View style={[styles.row, styles.headRow]}>{header.map((h, c) => cell(h, c, true))}</View>
        {rows.map((row, r) => (
          // oxlint-disable-next-line react/no-array-index-key -- rows have no identity beyond position
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
      return (
        <CodeBlock code={block.text} lang={block.lang} label={block.label} open={block.open} />
      );
    case "list":
      return (
        <ListView ordered={block.ordered} start={block.start} items={block.items} muted={muted} />
      );
    case "quote":
      return (
        <View style={styles.quote}>
          {block.blocks.map((b, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- blocks have no identity beyond position
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
  markerBox: { alignItems: "flex-end", minWidth: 18, paddingTop: 3 },
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
