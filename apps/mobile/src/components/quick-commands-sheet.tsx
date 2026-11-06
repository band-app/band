import { Pencil, Plus, Trash2, Zap } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { AgentChoice } from "../lib/chat/use-worktree-tabs";
import {
  commandSummary,
  commandsForRepo,
  draftFor,
  draftProblem,
  draftToInput,
  type QuickCommand,
  type QuickCommandDraft,
} from "../lib/quick-commands.ts";
import { useQuickCommands } from "../lib/use-quick-commands";
import { colors, useScheme } from "../theme";
import { AgentIcon } from "./agent-icon";
import { Icon } from "./icon";

/**
 * The worktree's quick commands: the commands for its repo plus the global ones, with one tap to
 * run, and add, edit and delete. The list and the form share one modal, so a sheet never opens
 * over another.
 */
export function QuickCommandsSheet({
  visible,
  onClose,
  repo,
  agents,
  onRun,
}: {
  visible: boolean;
  onClose: () => void;
  repo: string;
  agents: AgentChoice[];
  /** Starts the command in this worktree. The sheet closes first. */
  onRun: (command: QuickCommand) => void;
}) {
  const { commands, loading, create, update, remove, markRun } = useQuickCommands();
  const shown = useMemo(() => commandsForRepo(commands, repo), [commands, repo]);
  // `undefined` is the list, `"new"` the blank form, a command its edit form.
  const [editing, setEditing] = useState<QuickCommand | "new" | undefined>();
  useEffect(() => {
    if (!visible) setEditing(undefined);
  }, [visible]);
  const agentLabel = (id: string) => agents.find((a) => a.id === id)?.label ?? id;
  const defaultAgentId = agents.find((a) => a.isDefault)?.id ?? agents[0]?.id ?? "";

  const confirmDelete = (command: QuickCommand) =>
    Alert.alert(`Delete ${command.label}?`, "This removes it on every device.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => remove.mutate(command.id) },
    ]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => (editing ? setEditing(undefined) : onClose())}
    >
      <View style={styles.page} testID="quick-commands__sheet">
        {editing ? (
          <CommandForm
            key={editing === "new" ? "new" : editing.id}
            command={editing === "new" ? undefined : editing}
            repo={repo}
            agents={agents}
            defaultAgentId={defaultAgentId}
            saving={create.isPending || update.isPending}
            onCancel={() => setEditing(undefined)}
            onSave={async (draft) => {
              const input = draftToInput(draft, repo);
              if (editing === "new") await create.mutateAsync(input);
              else await update.mutateAsync({ id: editing.id, command: input });
              setEditing(undefined);
            }}
          />
        ) : (
          <>
            <View style={styles.header}>
              <Text style={styles.title} accessibilityRole="header">
                Quick commands
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={onClose}
                hitSlop={8}
                testID="quick-commands__close"
              >
                <Text style={styles.done}>Done</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.body}>
              {shown.map((command) => (
                <View key={command.id} style={styles.row} testID="quick-commands__row">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Run ${command.label}`}
                    onPress={() => {
                      markRun.mutate(command.id);
                      onRun(command);
                    }}
                    style={styles.rowMain}
                    testID={`quick-commands__run-${command.id}`}
                  >
                    {command.action === "agent" ? (
                      <AgentIcon
                        type={agents.find((a) => a.id === command.agentId)?.type}
                        size={18}
                      />
                    ) : (
                      <Icon icon={Zap} />
                    )}
                    <View style={styles.text}>
                      <Text style={styles.label} numberOfLines={1}>
                        {command.label}
                      </Text>
                      <Text style={styles.summary} numberOfLines={1}>
                        {commandSummary(command, agentLabel)}
                      </Text>
                    </View>
                    {command.repo === null ? <Text style={styles.scope}>All repos</Text> : null}
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${command.label}`}
                    onPress={() => setEditing(command)}
                    hitSlop={8}
                    style={styles.iconButton}
                    testID={`quick-commands__edit-${command.id}`}
                  >
                    <Icon icon={Pencil} color={colors.mutedForeground} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${command.label}`}
                    onPress={() => confirmDelete(command)}
                    hitSlop={8}
                    style={styles.iconButton}
                    testID={`quick-commands__delete-${command.id}`}
                  >
                    <Icon icon={Trash2} color={colors.destructive} />
                  </Pressable>
                </View>
              ))}
              {!loading && shown.length === 0 ? (
                <Text style={styles.empty} testID="quick-commands__empty">
                  No quick commands for {repo} yet.
                </Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => setEditing("new")}
                style={styles.add}
                testID="quick-commands__add"
              >
                <Icon icon={Plus} />
                <Text style={styles.label}>Add quick command</Text>
              </Pressable>
            </ScrollView>
          </>
        )}
      </View>
    </Modal>
  );
}

function CommandForm({
  command,
  repo,
  agents,
  defaultAgentId,
  saving,
  onCancel,
  onSave,
}: {
  command?: QuickCommand;
  repo: string;
  agents: AgentChoice[];
  defaultAgentId: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (draft: QuickCommandDraft) => Promise<void>;
}) {
  const scheme = useScheme();
  const [draft, setDraft] = useState(() => draftFor(command, defaultAgentId));
  const [error, setError] = useState<string | null>(null);
  const problem = draftProblem(draft);
  const set = (patch: Partial<QuickCommandDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = () => {
    if (problem) return;
    setError(null);
    onSave(draft).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : "Couldn't save the quick command."),
    );
  };

  return (
    <>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={onCancel}
          hitSlop={8}
          testID="quick-command-form__cancel"
        >
          <Text style={styles.done}>Cancel</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          {command ? "Edit quick command" : "Add quick command"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: problem !== null || saving }}
          disabled={problem !== null || saving}
          onPress={save}
          hitSlop={8}
          testID="quick-command-form__save"
        >
          <Text style={[styles.done, (problem !== null || saving) && styles.dim]}>Save</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Text style={styles.fieldLabel}>Label</Text>
        <TextInput
          keyboardAppearance={scheme}
          value={draft.label}
          onChangeText={(label) => set({ label })}
          placeholder="Start dev server"
          placeholderTextColor={colors.faint}
          style={styles.input}
          accessibilityLabel="Label"
          testID="quick-command-form__label"
        />
        <Text style={styles.fieldLabel}>Action</Text>
        <View style={styles.segment}>
          {(["terminal", "agent"] as const).map((action) => (
            <Pressable
              key={action}
              accessibilityRole="radio"
              accessibilityState={{ selected: draft.action === action }}
              onPress={() => set({ action })}
              style={[styles.segmentItem, draft.action === action && styles.segmentOn]}
              testID={`quick-command-form__action-${action}`}
            >
              <Text style={styles.label}>{action === "terminal" ? "Terminal" : "Agent"}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.fieldLabel}>{draft.action === "terminal" ? "Command" : "Prompt"}</Text>
        <TextInput
          keyboardAppearance={scheme}
          value={draft.body}
          onChangeText={(body) => set({ body })}
          placeholder={draft.action === "terminal" ? "npm run dev" : "Review the diff"}
          placeholderTextColor={colors.faint}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.multiline]}
          accessibilityLabel={draft.action === "terminal" ? "Command" : "Prompt"}
          testID="quick-command-form__body"
        />
        {draft.action === "terminal" ? (
          <View style={styles.switchRow}>
            <Text style={styles.label}>Append Enter, run immediately</Text>
            <Switch
              value={draft.appendEnter}
              onValueChange={(appendEnter) => set({ appendEnter })}
              testID="quick-command-form__append-enter"
            />
          </View>
        ) : (
          <>
            <Text style={styles.fieldLabel}>Agent</Text>
            {agents.map((a) => (
              <Pressable
                key={a.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: draft.agentId === a.id }}
                onPress={() => set({ agentId: a.id })}
                style={[styles.agentRow, draft.agentId === a.id && styles.segmentOn]}
                testID={`quick-command-form__agent-${a.id}`}
              >
                <AgentIcon type={a.type} size={18} />
                <Text style={styles.label}>{a.label}</Text>
              </Pressable>
            ))}
          </>
        )}
        <View style={styles.switchRow}>
          <Text style={styles.label}>Only in {repo}</Text>
          <Switch
            value={draft.thisRepoOnly}
            onValueChange={(thisRepoOnly) => set({ thisRepoOnly })}
            testID="quick-command-form__this-repo"
          />
        </View>
        {problem ? <Text style={styles.hint}>{problem}</Text> : null}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert" testID="quick-command-form__error">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.background, flex: 1 },
  header: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 16,
  },
  title: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
  done: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  dim: { opacity: 0.4 },
  body: { paddingBottom: 32 },
  row: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    paddingRight: 8,
  },
  rowMain: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 58,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  text: { flex: 1, minWidth: 0 },
  label: { color: colors.foreground, fontSize: 16 },
  summary: { color: colors.mutedForeground, fontSize: 13 },
  scope: { color: colors.mutedForeground, fontSize: 12 },
  iconButton: { alignItems: "center", height: 44, justifyContent: "center", width: 40 },
  empty: { color: colors.mutedForeground, fontSize: 14, padding: 16 },
  add: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 58, padding: 16 },
  form: { gap: 8, padding: 16, paddingBottom: 48 },
  fieldLabel: { color: colors.mutedForeground, fontSize: 13, marginTop: 8 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.foreground,
    fontSize: 16,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  multiline: { fontFamily: "Menlo", minHeight: 120, textAlignVertical: "top" },
  segment: { flexDirection: "row", gap: 8 },
  segmentItem: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    height: 44,
    justifyContent: "center",
  },
  segmentOn: { backgroundColor: colors.muted },
  switchRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 44,
  },
  agentRow: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  hint: { color: colors.mutedForeground, fontSize: 13 },
  error: { color: colors.destructive, fontSize: 14 },
});
