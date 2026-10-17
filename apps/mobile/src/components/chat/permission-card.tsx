import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  permissionInput,
  permissionTexts,
  type RequestEntry,
} from "../../lib/chat/pending-request";
import { colors, floating, tones } from "../../theme";
import { Button } from "../ui";
import { Markdown } from "./markdown";

type PermissionEntry = Extract<RequestEntry, { kind: "permission" }>;

/**
 * An ACP `session/request_permission`: the agent's own rules say to ask before running a tool
 * call. Shows the call, its input, any content the agent attached (Claude Code's plan approval
 * carries the plan), and one button per option the agent offered, with the agent's own wording.
 */
export function PermissionCard({
  entry,
  onAnswer,
}: {
  entry: PermissionEntry;
  onAnswer: (optionId: string | null) => Promise<void>;
}) {
  const { toolCall, options } = entry.request;
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = useCallback(
    async (optionId: string | null) => {
      setSending(optionId ?? "cancel");
      setError(null);
      try {
        await onAnswer(optionId);
      } catch {
        setError("Couldn't send the answer. Try again.");
        setSending(null);
      }
    },
    [onAnswer],
  );

  const input = permissionInput(entry);
  const texts = permissionTexts(entry);
  return (
    <View style={styles.card} testID="request__permission">
      <Text style={styles.title}>
        <Text style={styles.muted}>The agent asks to run </Text>
        {toolCall.title ?? "a tool"}
      </Text>
      {input.length > 0 ? (
        <View style={styles.input}>
          {input.map((line) => (
            <Text key={line} style={styles.inputLine} numberOfLines={6}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {texts.map((text) => (
        <Markdown key={text} text={text} />
      ))}
      <View style={styles.options}>
        {options.map((option) => (
          <View key={option.optionId} style={styles.option}>
            <Button
              label={option.name}
              variant={option.kind.startsWith("allow") ? "primary" : "secondary"}
              busy={sending === option.optionId}
              disabled={sending !== null}
              onPress={() => void answer(option.optionId)}
              testID={`request__option-${option.optionId}`}
            />
          </View>
        ))}
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" testID="request__error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export const requestCardStyles = StyleSheet.create({
  card: {
    ...floating,
    shadowOpacity: 0.1,
    backgroundColor: colors.card,
    borderColor: tones.attention,
    borderRadius: 24,
    borderWidth: 1,
    gap: 10,
    marginHorizontal: 12,
    marginTop: 6,
    padding: 14,
  },
});

const styles = StyleSheet.create({
  card: requestCardStyles.card,
  title: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  muted: { color: colors.mutedForeground, fontWeight: "400" },
  input: { backgroundColor: colors.muted, borderRadius: 14, gap: 2, padding: 10 },
  inputLine: { color: colors.foreground, fontFamily: "Menlo", fontSize: 13 },
  options: { gap: 8 },
  option: { alignSelf: "stretch" },
  error: { color: colors.destructive, fontSize: 14 },
});
