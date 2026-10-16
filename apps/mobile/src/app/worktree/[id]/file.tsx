import { useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { ChatProvider } from "../../../components/chat/chat-context";
import { Markdown } from "../../../components/chat/markdown";
import { CodeList, type CodeRow } from "../../../components/files/code-list";
import { ViewHeader } from "../../../components/files/view-header";
import { Body } from "../../../components/ui";
import { highlight } from "../../../lib/chat/highlight";
import { splitRunsIntoLines, textLines } from "../../../lib/files/code-lines";
import { baseName, dirName, fileKind, languageForPath } from "../../../lib/files/paths";
import { SessionGate, useHubSession } from "../../../lib/hub-session";
import { colors } from "../../../theme";

export default function FileRoute() {
  const { id, path, line } = useLocalSearchParams<{ id: string; path: string; line?: string }>();
  return (
    <SessionGate>
      <FileScreen worktreeId={id} path={path} line={line ? Number(line) : undefined} />
    </SessionGate>
  );
}

/** Whole files up to this size are highlighted in one pass; larger ones show plain text. */
const HIGHLIGHT_FILE_LIMIT = 150_000;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FileScreen({
  worktreeId,
  path,
  line,
}: {
  worktreeId: string;
  path: string;
  line?: number;
}) {
  const { client, hub } = useHubSession();
  const kind = fileKind(path);
  const file = useQuery({
    queryKey: ["worktree.getFile", worktreeId, path],
    queryFn: () => client.worktree.getFile.query({ worktreeId, path }),
    // An image is fetched by the Image from its own URL, so there is no need to read it as text.
    enabled: kind !== "image",
  });
  const data = file.data;
  const text = data && "content" in data ? data.content : null;
  const [source, setSource] = useState(false);

  const copy = () => {
    if (text === null) return;
    Clipboard.setStringAsync(text).then(
      () => Alert.alert("Copied", baseName(path)),
      () => Alert.alert("Couldn't copy"),
    );
  };

  let body: ReactNode;
  if (kind === "image") {
    body = <ImageView hubUrl={hub.url} token={hub.token} worktreeId={worktreeId} path={path} />;
  } else if (file.error) {
    body = <Notice testID="file__error" text={file.error.message} />;
  } else if (!data) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  } else if ("tooLarge" in data) {
    body = (
      <Notice
        testID="file__unavailable"
        title="Can't preview this file"
        text={`It is ${formatSize(data.size)}, over the 1 MB the hub reads.`}
      />
    );
  } else if ("binary" in data) {
    body = (
      <Notice
        testID="file__unavailable"
        title="Can't preview this file"
        text={`It is a binary file of ${formatSize(data.size)}.`}
      />
    );
  } else if (kind === "pdf") {
    body = (
      <Notice
        testID="file__unavailable"
        title="Can't preview this file"
        text="PDF files don't open in the app yet."
      />
    );
  } else if (kind === "markdown" && !source && data.content.length <= HIGHLIGHT_FILE_LIMIT) {
    body = (
      <ChatProvider
        hubUrl={hub.url}
        token={hub.token}
        onCopied={() => {}}
        onToggle={() => {}}
        rowFor={() => undefined}
      >
        <ScrollView contentContainerStyle={styles.markdown} testID="file__markdown">
          <Markdown text={data.content} />
        </ScrollView>
      </ChatProvider>
    );
  } else {
    body = (
      <SourceView
        content={data.content}
        language={languageForPath(path, data.language)}
        line={line}
        onRefresh={() => void file.refetch()}
        refreshing={file.isRefetching}
      />
    );
  }

  return (
    <View style={styles.screen} testID="file__screen">
      <ViewHeader title={baseName(path)} subtitle={dirName(path) || "/"} testID="file" />
      {text !== null ? (
        <View style={styles.bar}>
          {kind === "markdown" && text.length <= HIGHLIGHT_FILE_LIMIT ? (
            <View style={styles.modes}>
              {[false, true].map((isSource) => (
                <Pressable
                  key={String(isSource)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: source === isSource }}
                  onPress={() => setSource(isSource)}
                  style={[styles.mode, source === isSource && styles.modeOn]}
                  testID={isSource ? "file__show-source" : "file__show-rendered"}
                >
                  <Text style={[styles.modeText, source === isSource && styles.modeTextOn]}>
                    {isSource ? "Source" : "Rendered"}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <View />
          )}
          {text !== null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy file"
              onPress={copy}
              hitSlop={8}
              testID="file__copy"
            >
              <Text style={styles.copy}>Copy</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={styles.fill}>{body}</View>
    </View>
  );
}

function Notice({ title, text, testID }: { title?: string; text: string; testID: string }) {
  return (
    <View style={styles.center}>
      {title ? (
        <Text style={styles.noticeTitle} testID={`${testID}-title`}>
          {title}
        </Text>
      ) : null}
      <Body testID={testID}>{text}</Body>
    </View>
  );
}

/** The file's lines with numbers, highlighted once the first paint is done. */
function SourceView({
  content,
  language,
  line,
  onRefresh,
  refreshing,
}: {
  content: string;
  language: string;
  line?: number;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const lines = useMemo(() => textLines(content), [content]);
  const [highlighted, setHighlighted] = useState<ReturnType<typeof splitRunsIntoLines> | null>(
    null,
  );
  useEffect(() => {
    setHighlighted(null);
    if (!language || content.length > HIGHLIGHT_FILE_LIMIT) return;
    // After the plain text is on screen, so a big file shows at once and gains its colors.
    const timer = setTimeout(() => {
      const split = splitRunsIntoLines(highlight(content, language, HIGHLIGHT_FILE_LIMIT));
      setHighlighted(split);
    }, 0);
    return () => clearTimeout(timer);
  }, [content, language]);
  const focus = line && line >= 1 && line <= lines.length ? line - 1 : undefined;
  const rows = useMemo<CodeRow[]>(
    () =>
      lines.map((text, i) => ({
        key: String(i),
        text,
        runs: highlighted?.[i],
        gutter: [String(i + 1)],
        tone: i === focus ? "focus" : undefined,
      })),
    [lines, highlighted, focus],
  );
  return (
    <CodeList
      rows={rows}
      initialIndex={focus === undefined ? undefined : Math.max(0, focus - 3)}
      onRefresh={onRefresh}
      refreshing={refreshing}
      testID="file__code"
    />
  );
}

/** An image from the hub, with the system's pinch zoom. */
function ImageView({
  hubUrl,
  token,
  worktreeId,
  path,
}: {
  hubUrl: string;
  token: string;
  worktreeId: string;
  path: string;
}) {
  const { width, height } = useWindowDimensions();
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const uri = `${hubUrl}/api/worktree-file/${encodeURIComponent(worktreeId)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  if (failed)
    return (
      <Notice
        testID="file__unavailable"
        title="Can't preview this file"
        text="The image didn't load."
      />
    );
  return (
    <ScrollView
      maximumZoomScale={6}
      minimumZoomScale={1}
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.imageContent}
      testID="file__image-zoom"
    >
      <Image
        // no-store keeps iOS's URL cache from writing the Authorization header to disk.
        source={{ uri, headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" } }}
        style={{ width, height: height * 0.6 }}
        resizeMode="contain"
        onError={() => setFailed(true)}
        onLoad={(e) => setSize({ w: e.nativeEvent.source.width, h: e.nativeEvent.source.height })}
        accessibilityLabel={baseName(path)}
        testID="file__image"
      />
      {size ? (
        <Text style={styles.dimensions} testID="file__image-size">
          {size.w} × {size.h}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  fill: { flex: 1 },
  center: { alignItems: "center", flex: 1, gap: 8, justifyContent: "center", padding: 24 },
  noticeTitle: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
  bar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 8,
    paddingHorizontal: 14,
  },
  modes: { backgroundColor: colors.muted, borderRadius: 10, flexDirection: "row", padding: 2 },
  mode: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 5 },
  modeOn: { backgroundColor: colors.card },
  modeText: { color: colors.mutedForeground, fontSize: 13, fontWeight: "500" },
  modeTextOn: { color: colors.foreground },
  copy: { color: colors.mutedForeground, fontSize: 15 },
  markdown: { padding: 16 },
  imageContent: { alignItems: "center", flexGrow: 1, justifyContent: "center" },
  dimensions: { color: colors.mutedForeground, fontSize: 12, marginTop: 8 },
});
