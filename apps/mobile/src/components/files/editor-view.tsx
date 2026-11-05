import { useNavigation } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { embedUrl } from "../../lib/extensions/editors";
import { parsePageMessage } from "../../lib/extensions/page-message";
import { colors } from "../../theme";
import { Body } from "../ui";

/**
 * Reports the page's dirty state to the app. The embed page exposes it as `data-dirty` on its
 * `extension-editor__dirty` element, so this watches that attribute and posts the flag.
 */
const DIRTY_BRIDGE = `(function () {
  var last = null;
  function check() {
    var el = document.querySelector('[data-testid="extension-editor__dirty"]');
    var dirty = el ? el.getAttribute("data-dirty") === "true" : false;
    if (dirty === last) return;
    last = dirty;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "dirty", dirty: dirty }));
  }
  new MutationObserver(check).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["data-dirty"],
  });
  check();
})();
true;`;

/**
 * An extension editor for a file: the hub's `/embed/editor` page in a WebView, in the compact
 * layout with its own Save button. The page owns the dirty state and Save and reports
 * the dirty flag (`parsePageMessage`); leaving the screen while it is dirty asks first.
 */
export function EditorView({
  hubUrl,
  token,
  worktreeId,
  path,
  editorRef,
}: {
  hubUrl: string;
  token: string;
  worktreeId: string;
  path: string;
  editorRef: string;
}) {
  const navigation = useNavigation();
  const dirty = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (!dirty.current) return;
        event.preventDefault();
        Alert.alert("Discard changes?", "This file has unsaved changes.", [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => {
              dirty.current = false;
              navigation.dispatch(event.data.action);
            },
          },
        ]);
      }),
    [navigation],
  );

  const onMessage = (event: WebViewMessageEvent) => {
    const message = parsePageMessage(event.nativeEvent.data);
    if (message) dirty.current = message.dirty;
  };

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Can't open the editor</Text>
        <Body testID="file__editor-error">{error}</Body>
      </View>
    );
  }
  return (
    <View style={styles.fill} testID="file__editor">
      <WebView
        source={{ uri: embedUrl(hubUrl, token, worktreeId, path, editorRef) }}
        style={styles.fill}
        // The token link sets a login cookie. A non-persistent store keeps it, and the cache,
        // out of the app's files.
        incognito
        cacheEnabled={false}
        injectedJavaScript={DIRTY_BRIDGE}
        allowsBackForwardNavigationGestures={false}
        automaticallyAdjustContentInsets={false}
        onMessage={onMessage}
        onLoadEnd={() => setLoading(false)}
        onError={(e) => setError(e.nativeEvent.description || "The page didn't load.")}
        onHttpError={(e) => setError(`The hub answered HTTP ${e.nativeEvent.statusCode}.`)}
        testID="file__editor-webview"
      />
      {loading ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator color={colors.mutedForeground} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { backgroundColor: colors.background, flex: 1 },
  center: { alignItems: "center", flex: 1, gap: 8, justifyContent: "center", padding: 24 },
  title: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
  loading: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
});
