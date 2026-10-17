import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { FileIcon } from "../../../components/file-icon";
import { CodeList, type CodeRow } from "../../../components/files/code-list";
import { ViewHeader } from "../../../components/files/view-header";
import { Body } from "../../../components/ui";
import type { ChangeSection } from "../../../lib/files/changes";
import { baseName, dirName, languageForPath } from "../../../lib/files/paths";
import { parseUnifiedDiff } from "../../../lib/files/unified-diff";
import { SessionGate, useHubSession } from "../../../lib/hub-session";
import { colors } from "../../../theme";

export default function DiffRoute() {
  const params = useLocalSearchParams<{
    id: string;
    path: string;
    section: ChangeSection;
    oldPath?: string;
    mergeBase?: string;
  }>();
  return (
    <SessionGate>
      <Diff
        worktreeId={params.id}
        path={params.path}
        section={params.section}
        oldPath={params.oldPath}
        mergeBase={params.mergeBase}
      />
    </SessionGate>
  );
}

function Diff({
  worktreeId,
  path,
  section,
  oldPath,
  mergeBase,
}: {
  worktreeId: string;
  path: string;
  section: ChangeSection;
  oldPath?: string;
  mergeBase?: string;
}) {
  const { client } = useHubSession();
  const result = useQuery({
    queryKey: ["worktree.getFileDiff", worktreeId, section, path, oldPath, mergeBase],
    queryFn: () =>
      client.worktree.getFileDiff.query({
        worktreeId,
        filePath: path,
        section,
        ...(oldPath ? { oldPath } : {}),
        ...(mergeBase ? { mergeBase } : {}),
      }),
  });
  const parsed = useMemo(
    () => (result.data ? parseUnifiedDiff(result.data.diff) : null),
    [result.data],
  );
  const rows = useMemo<CodeRow[]>(
    () =>
      (parsed?.rows ?? []).map((row, i) => ({
        key: String(i),
        text: row.text,
        tone: row.kind === "context" ? undefined : row.kind,
        gutter:
          row.kind === "hunk" || row.kind === "note"
            ? undefined
            : [
                row.oldLine === undefined ? "" : String(row.oldLine),
                row.newLine === undefined ? "" : String(row.newLine),
              ],
      })),
    [parsed],
  );
  return (
    <View style={styles.screen} testID="diff__screen">
      <ViewHeader
        title={baseName(path)}
        icon={<FileIcon name={path} size={16} />}
        subtitle={
          parsed && !parsed.binary
            ? `+${parsed.added} −${parsed.removed} · ${dirName(path) || "/"}`
            : dirName(path) || "/"
        }
        testID="diff"
      />
      {result.error ? (
        <View style={styles.center}>
          <Body testID="diff__error">{result.error.message}</Body>
        </View>
      ) : !parsed ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.mutedForeground} />
        </View>
      ) : parsed.binary ? (
        <View style={styles.center}>
          <Text style={styles.title} testID="diff__binary">
            Binary file
          </Text>
          <Body>The two versions differ, but there is no text to show.</Body>
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.title} testID="diff__empty">
            No text changes
          </Text>
          <Body>The file's mode or its line endings may have changed.</Body>
        </View>
      ) : (
        <CodeList
          rows={rows}
          language={languageForPath(path)}
          gutterColumns={2}
          onRefresh={() => void result.refetch()}
          refreshing={result.isRefetching}
          testID="diff__list"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  center: { alignItems: "center", flex: 1, gap: 8, justifyContent: "center", padding: 24 },
  title: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
});
