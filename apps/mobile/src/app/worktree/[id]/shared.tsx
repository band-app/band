import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { ChatProvider } from "../../../components/chat/chat-context";
import { Markdown } from "../../../components/chat/markdown";
import { FileIcon } from "../../../components/file-icon";
import { ViewHeader } from "../../../components/files/view-header";
import { fileKind, languageForPath } from "../../../lib/files/paths";
import { SessionGate, useHubSession } from "../../../lib/hub-session";
import { colors } from "../../../theme";
import { Notice, SourceView } from "./file";

export default function SharedFileRoute() {
  const { url, name } = useLocalSearchParams<{ id: string; url: string; name: string }>();
  return (
    <SessionGate>
      <SharedFileScreen url={url} name={name} />
    </SessionGate>
  );
}

function hasNul(text: string): boolean {
  return text.slice(0, 8000).includes("\0");
}

/** A file an agent shared in a chat, shown read-only. Types the app can't show go to the system browser. */
function SharedFileScreen({ url, name }: { url: string; name: string }) {
  const { hub } = useHubSession();
  const kind = fileKind(name);
  const { width, height } = useWindowDimensions();
  const auth = { Authorization: `Bearer ${hub.token}`, "Cache-Control": "no-store" };
  const needsText = kind === "markdown" || kind === "code";
  const file = useQuery({
    queryKey: ["shared-file", url],
    enabled: needsText,
    queryFn: async () => {
      const res = await fetch(`${hub.url}${url}`, { headers: auth });
      if (!res.ok) throw new Error(`The hub answered ${res.status}`);
      return res.text();
    },
  });
  // The system browser downloads or previews it, with the hub's `?token=` link login.
  const openExternally = () => {
    void Linking.openURL(
      `${hub.url}${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(hub.token)}`,
    );
  };

  let body: ReactNode;
  if (kind === "image") {
    body = (
      <ScrollView
        maximumZoomScale={6}
        minimumZoomScale={1}
        centerContent
        testID="shared__image-zoom"
      >
        <Image
          source={{ uri: `${hub.url}${url}`, headers: auth }}
          style={{ width, height: height * 0.6 }}
          resizeMode="contain"
          accessibilityLabel={name}
          testID="shared__image"
        />
      </ScrollView>
    );
  } else if (kind === "pdf") {
    body = <External onOpen={openExternally} text="PDF files open in your browser." />;
  } else if (file.error) {
    body = <Notice testID="shared__error" text={file.error.message} />;
  } else if (file.data === undefined) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  } else if (hasNul(file.data)) {
    body = <External onOpen={openExternally} text="This file can't be shown in the app." />;
  } else if (kind === "markdown") {
    body = (
      <ChatProvider
        hubUrl={hub.url}
        token={hub.token}
        onCopied={() => {}}
        onToggle={() => {}}
        rowFor={() => undefined}
      >
        <ScrollView contentContainerStyle={styles.markdown} testID="shared__markdown">
          <Markdown text={file.data} />
        </ScrollView>
      </ChatProvider>
    );
  } else {
    body = (
      <SourceView
        content={file.data}
        language={languageForPath(name)}
        onRefresh={() => void file.refetch()}
        refreshing={file.isRefetching}
      />
    );
  }

  return (
    <View style={styles.screen} testID="shared__screen">
      <ViewHeader
        title={name}
        subtitle="Shared by the agent"
        icon={<FileIcon name={name} size={16} />}
        testID="shared"
      />
      <View style={styles.fill}>{body}</View>
    </View>
  );
}

function External({ text, onOpen }: { text: string; onOpen: () => void }) {
  return (
    <View style={styles.center} testID="shared__external">
      <Text style={styles.text}>{text}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onOpen}
        style={styles.button}
        testID="shared__open-external"
      >
        <Text style={styles.buttonText}>Download</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  fill: { flex: 1 },
  center: { alignItems: "center", flex: 1, gap: 12, justifyContent: "center", padding: 24 },
  markdown: { padding: 16 },
  text: { color: colors.mutedForeground, fontSize: 15 },
  button: {
    backgroundColor: colors.muted,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  buttonText: { color: colors.foreground, fontSize: 15, fontWeight: "500" },
});
