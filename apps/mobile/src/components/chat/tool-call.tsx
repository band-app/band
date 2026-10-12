import { diffLines } from "@band-app/client/diff-lines";
import {
  describeTool,
  formatToolDuration,
  hasToolDetails,
  OUTPUT_LIMIT,
  type ShellRun,
  shellRun,
  shownExitCode,
  summarizeTools,
  type ToolLabel,
  toolDetails,
  toolDuration,
  toolState,
} from "@band-app/client/tool-summary";
import type { ToolEntry } from "@band-app/client/transcript";
import { memo, type ReactNode, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { chatColors, colors, fonts, tones } from "../../theme";
import { useOpen } from "./chat-context";
import { Markdown } from "./markdown";

/** A diff shows this many lines before "N more lines"; a phone has no room for a whole file. */
const DIFF_LINE_LIMIT = 300;

function Label({ label, failed }: { label: ToolLabel; failed: boolean }) {
  const at = label.highlight ? label.text.indexOf(label.highlight) : -1;
  if (!label.highlight || at < 0) return label.text;
  return (
    <>
      {label.text.slice(0, at)}
      <Text style={failed ? undefined : styles.highlight}>{label.highlight}</Text>
      {label.text.slice(at + label.highlight.length)}
    </>
  );
}

/** A tappable one-line row: the label, a chevron when it opens, and how long its calls took. */
function Row({
  tools,
  open,
  onToggle,
  tone,
  running,
  testID,
  children,
}: {
  tools: ToolEntry[];
  open: boolean;
  onToggle?: () => void;
  tone: "muted" | "error";
  running: boolean;
  testID: string;
  children: ReactNode;
}) {
  const ms = toolDuration(tools);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open, disabled: !onToggle }}
      disabled={!onToggle}
      onPress={onToggle}
      hitSlop={4}
      style={styles.row}
      testID={testID}
    >
      <Text
        numberOfLines={1}
        style={[styles.label, tone === "error" && styles.error, running && styles.running]}
      >
        {children}
      </Text>
      {onToggle ? <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text> : null}
      {ms !== undefined ? <Text style={styles.duration}>{formatToolDuration(ms)}</Text> : null}
    </Pressable>
  );
}

function Diff({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText?: string | null;
  newText: string;
}) {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  const shown = lines.slice(0, DIFF_LINE_LIMIT);
  return (
    <View style={styles.box} testID="tool-call__diff">
      <View style={styles.boxHeader}>
        <Text style={styles.mono} numberOfLines={1}>
          {path}
          {!oldText ? <Text style={{ color: chatColors.addedText }}> new file</Text> : null}
        </Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.diffBody}>
          {shown.map((line, i) =>
            line.kind === "gap" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond position
              <Text key={i} style={[styles.diffLine, styles.dim]}>
                ⋯ {line.skipped} unchanged {line.skipped === 1 ? "line" : "lines"}
              </Text>
            ) : (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond position
                key={i}
                style={[
                  styles.diffLine,
                  line.kind === "add" && styles.added,
                  line.kind === "del" && styles.removed,
                ]}
              >
                <Text style={styles.dim}>
                  {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                </Text>
                {line.text}
              </Text>
            ),
          )}
          {lines.length > shown.length ? (
            <Text style={[styles.diffLine, styles.dim]}>
              {lines.length - shown.length} more lines
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function Output({ text, failed }: { text: string; failed?: boolean }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <Text style={[styles.mono, failed ? styles.error : styles.dim]} testID="tool-call__output">
        {text.slice(0, OUTPUT_LIMIT)}
      </Text>
    </ScrollView>
  );
}

/** A shell call: the command, then the exit code and output. */
function ShellDetails({ run, failed }: { run: ShellRun; failed: boolean }) {
  const exitCode = shownExitCode(run, failed);
  return (
    <View style={styles.details}>
      <View style={styles.command} testID="tool-call__command">
        <Text style={styles.mono}>
          <Text style={styles.dim}>$ </Text>
          {run.command}
        </Text>
      </View>
      {exitCode !== undefined ? (
        <Text style={[styles.mono, styles.error]}>Exit code {exitCode}</Text>
      ) : null}
      {run.output ? <Output text={run.output} failed={failed} /> : null}
    </View>
  );
}

function json(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolDetails({ entry }: { entry: ToolEntry }) {
  const { diffs, texts, prose } = toolDetails(entry);
  const raw = diffs.length === 0 && texts.length === 0;
  return (
    <View style={styles.details}>
      {diffs.map((d) => (
        <Diff key={d.path} path={d.path} oldText={d.oldText} newText={d.newText} />
      ))}
      {texts.map((text, i) =>
        prose ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: content blocks have no id
          <Markdown key={i} text={text} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: content blocks have no id
          <Output key={i} text={text} />
        ),
      )}
      {raw && entry.rawInput !== undefined ? <Output text={json(entry.rawInput)} /> : null}
      {raw && entry.rawOutput !== undefined ? <Output text={json(entry.rawOutput)} /> : null}
    </View>
  );
}

/**
 * One tool call as one line, red when it failed. Tapping it shows a shell call's command, exit
 * code and output, or what else the agent reported: file edits as diffs, text, raw input.
 */
export const ToolCall = memo(function ToolCall({ entry }: { entry: ToolEntry }) {
  const [open, toggle] = useOpen(entry.id);
  const state = toolState(entry);
  const failed = state === "error";
  const body = hasToolDetails(entry);
  // Parsed only while open, so a collapsed row never scans the output.
  const shell = open ? shellRun(entry) : null;
  return (
    <View testID="tool-call__container">
      <Row
        tools={[entry]}
        open={open}
        onToggle={body ? toggle : undefined}
        tone={failed ? "error" : "muted"}
        running={state === "in-progress"}
        testID="tool-call__label"
      >
        <Label label={describeTool(entry)} failed={failed} />
      </Row>
      {open ? (
        shell ? (
          <ShellDetails run={shell} failed={failed} />
        ) : (
          <ToolDetails entry={entry} />
        )
      ) : null}
    </View>
  );
});

/** Consecutive tool calls folded into one summary line; open, each call is its own row. */
export const ToolGroup = memo(function ToolGroup({
  id,
  tools,
  children,
}: {
  id: string;
  tools: ToolEntry[];
  children: ReactNode;
}) {
  const [open, toggle] = useOpen(id);
  const running = tools.some((t) => toolState(t) === "in-progress");
  return (
    <View testID="tool-group__container">
      <Row
        tools={tools}
        open={open}
        onToggle={toggle}
        tone="muted"
        running={running}
        testID="tool-group__summary"
      >
        {summarizeTools(tools)}
      </Row>
      {open ? <View style={styles.group}>{children}</View> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { alignItems: "center", flexDirection: "row", gap: 6, minHeight: 28 },
  label: { color: colors.mutedForeground, flexShrink: 1, fontSize: 15 },
  highlight: { color: colors.foreground },
  error: { color: tones.failure },
  running: { opacity: 0.7 },
  chevron: { color: colors.mutedForeground, fontSize: 13 },
  duration: { color: colors.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"] },
  details: { gap: 8, marginTop: 6 },
  group: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    marginTop: 6,
    padding: 10,
  },
  box: {
    borderColor: colors.border,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  boxHeader: {
    backgroundColor: colors.muted,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  diffBody: { paddingVertical: 4 },
  diffLine: {
    color: colors.foreground,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 8,
  },
  added: { backgroundColor: chatColors.added },
  removed: { backgroundColor: chatColors.removed },
  dim: { color: colors.mutedForeground },
  mono: { color: colors.foreground, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
  command: {
    backgroundColor: colors.muted,
    borderColor: colors.border,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
});
