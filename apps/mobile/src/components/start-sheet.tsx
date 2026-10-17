import { toWorktreeId } from "@band-app/shared/worktree-id";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useHubSession } from "../lib/hub-session";
import type { RepoLike } from "../lib/worktree-list";
import { colors, useScheme } from "../theme";
import { RepoAvatar } from "./repo-avatar";

/** A branch name git accepts: no spaces, no `..`, and none of the characters it reserves. */
export function validBranch(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.includes("..") &&
    !/[./]$/.test(name) &&
    !name.startsWith("/") &&
    !name.startsWith("-") &&
    !name.includes("//") &&
    !name.endsWith(".lock")
  );
}

/**
 * Starts an agent from the home screen: pick a repo, then a worktree (an existing one, or a new
 * branch), write the first message. A new branch is created with the message as its prompt; an
 * existing worktree gets a new chat that starts with it. Then the worktree opens.
 */
export function StartSheet({
  visible,
  onClose,
  repos,
}: {
  visible: boolean;
  onClose: () => void;
  repos: readonly (RepoLike & { worktrees: { name: string; hostId?: string }[] })[];
}) {
  const { client, hub } = useHubSession();
  const scheme = useScheme();
  const [message, setMessage] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  // null: a new branch; otherwise the id of an existing worktree.
  const [target, setTarget] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);

  const picked = repos.find((r) => r.name === repo);
  const newBranch = target === null;
  const ready =
    message.trim().length > 0 && picked !== undefined && (!newBranch || validBranch(branch.trim()));

  const close = () => {
    if (!busy) onClose();
  };

  const send = async () => {
    if (!picked || !ready) return;
    setBusy(true);
    try {
      let worktreeId: string;
      if (target === null) {
        const result = await client.worktrees.create.mutate({
          repo: picked.name,
          branch: branch.trim(),
          prompt: message.trim(),
          agentMode: "gui",
        });
        if (result.provisioning) throw new Error("No host is ready for this repo yet.");
        worktreeId = toWorktreeId(picked.name, branch.trim(), result.hostId);
      } else {
        worktreeId = target;
        await client.agentSessions.launch.mutate({
          worktreeId,
          prompt: message.trim(),
          mode: "gui",
        });
      }
      setMessage("");
      setBranch("");
      setTarget(null);
      onClose();
      router.push({ pathname: "/worktree/[id]", params: { id: worktreeId } });
    } catch (err) {
      Alert.alert("Couldn't start the agent", err instanceof Error ? err.message : "Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        style={styles.sheet}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        testID="start__sheet"
      >
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Start an agent
          </Text>
          <Pressable accessibilityRole="button" onPress={close} hitSlop={8} testID="start__cancel">
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <TextInput
            keyboardAppearance={scheme}
            value={message}
            onChangeText={setMessage}
            placeholder="Plan, ask, build…"
            placeholderTextColor={colors.faint}
            multiline
            style={styles.input}
            accessibilityLabel="Message"
            testID="start__message"
          />
          <Text style={styles.label}>Repo</Text>
          <View style={styles.group}>
            {repos.map((r, i) => (
              <Choice
                key={r.name}
                label={r.name}
                icon={
                  <RepoAvatar
                    name={r.name}
                    src={r.avatar?.src}
                    base={hub.url}
                    token={hub.token}
                    size={24}
                  />
                }
                selected={r.name === repo}
                divided={i > 0}
                onPress={() => {
                  setRepo(r.name);
                  setTarget(null);
                }}
                testID={`start__repo-${r.name}`}
              />
            ))}
          </View>
          {picked ? (
            <>
              <Text style={styles.label}>Worktree</Text>
              <View style={styles.group}>
                <Choice
                  label="New branch"
                  selected={newBranch}
                  onPress={() => setTarget(null)}
                  testID="start__new-branch"
                />
                {newBranch ? (
                  <TextInput
                    keyboardAppearance={scheme}
                    value={branch}
                    onChangeText={setBranch}
                    placeholder="feat/my-change"
                    placeholderTextColor={colors.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.branch}
                    accessibilityLabel="Branch name"
                    testID="start__branch"
                  />
                ) : null}
                {picked.worktrees.map((w) => {
                  const id = toWorktreeId(picked.name, w.name, w.hostId);
                  return (
                    <Choice
                      key={id}
                      label={w.name}
                      divided
                      selected={target === id}
                      onPress={() => setTarget(id)}
                      testID={`start__worktree-${id}`}
                    />
                  );
                })}
              </View>
            </>
          ) : null}
        </ScrollView>
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start"
            accessibilityState={{ disabled: !ready || busy }}
            disabled={!ready || busy}
            onPress={() => void send()}
            style={[styles.start, (!ready || busy) && styles.startDisabled]}
            testID="start__send"
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.startText}>Start</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Choice({
  label,
  icon,
  selected,
  onPress,
  divided,
  testID,
}: {
  label: string;
  icon?: ReactNode;
  selected: boolean;
  onPress: () => void;
  divided?: boolean;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.choice, divided && styles.divided]}
      testID={testID}
    >
      {icon}
      <Text style={[styles.choiceLabel, icon ? styles.withIcon : null]} numberOfLines={1}>
        {label}
      </Text>
      {selected ? <Text style={styles.tick}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: colors.background, flex: 1 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 16,
  },
  title: { color: colors.foreground, fontSize: 20, fontWeight: "600" },
  link: { color: colors.foreground, fontSize: 16 },
  body: { gap: 8, padding: 16, paddingTop: 0 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.foreground,
    fontSize: 16,
    minHeight: 96,
    padding: 14,
    textAlignVertical: "top",
  },
  label: { color: colors.mutedForeground, fontSize: 14, marginLeft: 4, marginTop: 12 },
  group: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  choice: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: 14,
  },
  divided: { borderTopColor: colors.divider, borderTopWidth: StyleSheet.hairlineWidth },
  choiceLabel: { color: colors.foreground, flex: 1, fontSize: 16 },
  withIcon: { marginLeft: 10 },
  tick: { color: colors.foreground, fontSize: 16, fontWeight: "700" },
  branch: {
    borderTopColor: colors.divider,
    borderTopWidth: StyleSheet.hairlineWidth,
    color: colors.foreground,
    fontSize: 16,
    minHeight: 46,
    paddingHorizontal: 14,
  },
  footer: { padding: 16 },
  start: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 24,
    height: 48,
    justifyContent: "center",
  },
  startDisabled: { opacity: 0.35 },
  startText: { color: colors.primaryForeground, fontSize: 16, fontWeight: "600" },
});
