import {
  filterSkills,
  getCommandContext,
  getMentionContext,
  type SlashCommandSkill,
} from "@band-app/client/composer";
import { File, SquareSlash } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useHubSession } from "../../lib/hub-session";
import { colors } from "../../theme";
import { Icon } from "../icon";

/** What picking a suggestion does to the composer's text. */
export interface SuggestionResult {
  text: string;
  /** The picked command's argument hint, shown after the text. */
  hint: string | null;
}

/**
 * The list above the composer while the user types `/command` or `@file`. The slash list comes
 * from the session's commands and the file list from `worktree.searchFiles`, as on the web.
 */
export function ComposerSuggestions({
  text,
  skills,
  worktreeId,
  onPick,
}: {
  text: string;
  skills: SlashCommandSkill[];
  worktreeId: string;
  onPick: (result: SuggestionResult) => void;
}) {
  const command = skills.length > 0 ? getCommandContext(text) : null;
  const mention = command ? null : getMentionContext(text);

  if (command) {
    return (
      <SlashList query={command.query} prefix={command.prefix} skills={skills} onPick={onPick} />
    );
  }
  if (mention) {
    return (
      <FileList
        query={mention.query}
        prefix={mention.prefix}
        worktreeId={worktreeId}
        onPick={onPick}
      />
    );
  }
  return null;
}

function SlashList({
  query,
  prefix,
  skills,
  onPick,
}: {
  query: string;
  prefix: string;
  skills: SlashCommandSkill[];
  onPick: (result: SuggestionResult) => void;
}) {
  const matches = useMemo(() => filterSkills(skills, query).slice(0, 30), [skills, query]);
  if (matches.length === 0) return null;
  return (
    <Panel label="Slash commands" testID="suggestions__slash">
      {matches.map((skill) => (
        <Pressable
          key={skill.name}
          accessibilityRole="button"
          accessibilityLabel={`/${skill.name}`}
          onPress={() =>
            onPick({ text: `${prefix}/${skill.name} `, hint: skill.argumentHint ?? null })
          }
          style={styles.row}
          testID={`suggestions__command-${skill.name}`}
        >
          <Icon icon={SquareSlash} color={colors.mutedForeground} />
          <View style={styles.rowText}>
            <View style={styles.line}>
              <Text style={styles.name}>/{skill.name}</Text>
              {skill.argumentHint ? (
                <Text style={styles.hint} numberOfLines={1}>
                  {skill.argumentHint}
                </Text>
              ) : null}
            </View>
            <Text style={styles.description} numberOfLines={1}>
              {skill.description}
            </Text>
          </View>
        </Pressable>
      ))}
    </Panel>
  );
}

function FileList({
  query,
  prefix,
  worktreeId,
  onPick,
}: {
  query: string;
  prefix: string;
  worktreeId: string;
  onPick: (result: SuggestionResult) => void;
}) {
  const { client } = useHubSession();
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // The web waits 150 ms between keystrokes before it searches.
    const timer = setTimeout(
      () => {
        client.worktree.searchFiles
          .query({ worktreeId, query, limit: 15 })
          .then((result) => {
            if (!cancelled) setFiles(result.files);
          })
          .catch(() => {})
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      query ? 150 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, worktreeId, query]);

  if (files.length === 0 && !loading) return null;
  return (
    <Panel label="File mentions" testID="suggestions__files">
      {loading && files.length === 0 ? (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        </View>
      ) : (
        files.map((path) => (
          <Pressable
            key={path}
            accessibilityRole="button"
            accessibilityLabel={path}
            onPress={() => onPick({ text: `${prefix}@${path} `, hint: null })}
            style={styles.row}
            testID={`suggestions__file-${path}`}
          >
            <Icon icon={File} color={colors.mutedForeground} />
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>
                {path.split("/").pop() || path}
              </Text>
              <Text style={styles.description} numberOfLines={1}>
                {path}
              </Text>
            </View>
          </Pressable>
        ))
      )}
    </Panel>
  );
}

function Panel({
  children,
  label,
  testID,
}: {
  children: React.ReactNode;
  label: string;
  testID: string;
}) {
  return (
    <View style={styles.panel} accessibilityLabel={label} testID={testID}>
      <ScrollView keyboardShouldPersistTaps="always" style={styles.scroll}>
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 6,
    overflow: "hidden",
  },
  scroll: { maxHeight: 220 },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  rowText: { flex: 1, gap: 2 },
  line: { alignItems: "baseline", flexDirection: "row", gap: 8 },
  name: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  hint: { color: colors.mutedForeground, flexShrink: 1, fontSize: 12 },
  description: { color: colors.mutedForeground, fontSize: 12 },
});
