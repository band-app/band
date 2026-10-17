import {
  type Choice,
  type ElicitationEntry,
  type ElicitationValue,
  type ElicitationValues,
  type Field,
  fieldsOf,
  type Step,
  stepsOf,
  toContent,
  validateStep,
} from "@band-app/client/elicitation";
import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import { colors, tones, useScheme } from "../../theme";
import { Button } from "../ui";
import { requestCardStyles } from "./permission-card";

/**
 * An ACP form elicitation: the agent needs structured input, such as Claude Code's
 * AskUserQuestion (one select field per question, each with its own free-text box). Shows one
 * question at a time with a pager and an X that sends `decline`, like the web form. Picking an
 * option of a single-choice question moves on, and on the last question sends `accept` with the
 * values. Every other kind of answer moves on with Next (Submit on the last question), which
 * checks the values first and shows what is wrong under the field. Skip leaves the question
 * unanswered.
 */
export function ElicitationCard({
  entry,
  onAnswer,
}: {
  entry: ElicitationEntry;
  onAnswer: (action: "accept" | "decline", content?: ElicitationValues) => Promise<void>;
}) {
  const fields = useMemo(() => fieldsOf(entry), [entry]);
  const steps = useMemo(() => stepsOf(fields), [fields]);
  const [values, setValues] = useState<ElicitationValues>({});
  const [index, setIndex] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const { height } = useWindowDimensions();

  const step = steps[index] as Step | undefined;
  const isLast = index >= steps.length - 1;
  const single = steps.length === 1;
  const intro =
    steps.length > 1 && !fields.some((f) => f.customFor) ? entry.request.message : undefined;
  const question =
    step && !single
      ? (step.field.description ?? step.field.title ?? step.field.key)
      : entry.request.message;
  const detail = single ? step?.field.description : undefined;
  // A single-choice pick sends from the row; everything else needs a button.
  const needsNext =
    !!step &&
    (step.field.kind !== "single" || (!!step.note && values[step.note.key] !== undefined));

  const set = useCallback((key: string, value: ElicitationValue | undefined) => {
    setValues((prev) => {
      const next = { ...prev };
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);

  const submit = useCallback(
    async (action: "accept" | "decline", from: ElicitationValues) => {
      setSending(true);
      setFailed(false);
      try {
        await onAnswer(action, action === "accept" ? toContent(fields, from) : undefined);
      } catch {
        setFailed(true);
        setSending(false);
      }
    },
    [onAnswer, fields],
  );

  const goTo = useCallback((i: number) => {
    setIndex(i);
    setErrors({});
  }, []);

  /** Moves on from the current question with `from` as the values; checks them unless skipping. */
  const next = useCallback(
    (from: ElicitationValues, skipping = false) => {
      if (sending || !step) return;
      if (!skipping) {
        const found = validateStep(step, from);
        if (Object.keys(found).length > 0) {
          setErrors(found);
          return;
        }
      }
      if (isLast) void submit("accept", from);
      else goTo(index + 1);
    },
    [sending, step, isLast, submit, goTo, index],
  );

  const skip = useCallback(() => {
    if (!step) return;
    const rest = { ...values };
    delete rest[step.field.key];
    if (step.note) delete rest[step.note.key];
    setValues(rest);
    next(rest, true);
  }, [step, values, next]);

  const pick = useCallback(
    (field: Field, choice: Choice) => {
      if (sending) return;
      if (field.kind === "single") {
        const from = { ...values, [field.key]: choice.value };
        setValues(from);
        next(from);
        return;
      }
      const current = values[field.key];
      const list = Array.isArray(current) ? current : [];
      set(
        field.key,
        list.includes(choice.value)
          ? list.filter((v) => v !== choice.value)
          : [...list, choice.value],
      );
    },
    [sending, values, next, set],
  );

  return (
    <View style={requestCardStyles.card} testID="request__elicitation">
      <View style={styles.header}>
        <View style={styles.headerText}>
          {intro ? <Text style={styles.muted}>{intro}</Text> : null}
          <Text style={styles.question} testID="request__question">
            {question}
          </Text>
          {detail ? <Text style={styles.muted}>{detail}</Text> : null}
          {step?.field.kind === "multi" ? <Text style={styles.muted}>Pick any</Text> : null}
        </View>
        <View style={styles.pager}>
          {steps.length > 1 ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Previous question"
                disabled={sending || index === 0}
                onPress={() => goTo(index - 1)}
                hitSlop={8}
                style={[styles.pagerButton, (sending || index === 0) && styles.dim]}
                testID="request__previous"
              >
                <Text style={styles.pagerText}>‹</Text>
              </Pressable>
              <Text style={styles.pagerCount} testID="request__step">
                {index + 1} of {steps.length}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Next question"
                disabled={sending || isLast}
                onPress={() => goTo(index + 1)}
                hitSlop={8}
                style={[styles.pagerButton, (sending || isLast) && styles.dim]}
                testID="request__forward"
              >
                <Text style={styles.pagerText}>›</Text>
              </Pressable>
            </>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss questions"
            disabled={sending}
            onPress={() => void submit("decline", values)}
            hitSlop={8}
            style={[styles.pagerButton, sending && styles.dim]}
            testID="request__dismiss"
          >
            <Text style={styles.pagerText}>✕</Text>
          </Pressable>
        </View>
      </View>
      {step ? (
        <ScrollView
          style={{ maxHeight: height * 0.45 }}
          keyboardShouldPersistTaps="handled"
          testID="request__body"
        >
          <StepBody
            step={step}
            values={values}
            errors={errors}
            disabled={sending}
            onPick={pick}
            onSet={set}
          />
        </ScrollView>
      ) : null}
      {failed ? (
        <Text style={styles.error} accessibilityRole="alert" testID="request__error">
          Couldn't send the answer. Try again.
        </Text>
      ) : null}
      <View style={styles.buttons}>
        {step ? (
          <View style={styles.button}>
            <Button
              label="Skip"
              variant="secondary"
              disabled={sending}
              onPress={skip}
              testID="request__skip"
            />
          </View>
        ) : null}
        {needsNext || !step ? (
          <View style={styles.button}>
            <Button
              label={isLast || !step ? "Submit" : "Next"}
              busy={sending}
              onPress={() => (step ? next(values) : void submit("accept", {}))}
              testID="request__next"
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function StepBody({
  step,
  values,
  errors,
  disabled,
  onPick,
  onSet,
}: {
  step: Step;
  values: ElicitationValues;
  errors: Record<string, string>;
  disabled: boolean;
  onPick: (field: Field, choice: Choice) => void;
  onSet: (key: string, value: ElicitationValue | undefined) => void;
}) {
  const scheme = useScheme();
  const { field, note } = step;
  const current = values[field.key];
  const inputField = note ?? (field.kind === "text" || field.kind === "number" ? field : undefined);
  const text =
    inputField && typeof values[inputField.key] === "string"
      ? (values[inputField.key] as string)
      : "";
  const error = errors[field.key] ?? (note ? errors[note.key] : undefined);
  return (
    <View style={styles.stepBody}>
      {field.choices.map((choice, i) => {
        const selected = Array.isArray(current)
          ? current.includes(choice.value)
          : current === choice.value;
        return (
          <Pressable
            key={choice.value}
            accessibilityRole={field.kind === "multi" ? "checkbox" : "button"}
            accessibilityState={{ selected, checked: selected, disabled }}
            accessibilityLabel={choice.title}
            disabled={disabled}
            onPress={() => onPick(field, choice)}
            style={[styles.choice, selected && styles.choiceSelected]}
            testID={`request__choice-${choice.value}`}
          >
            <View style={[styles.number, selected && styles.numberSelected]}>
              <Text style={[styles.numberText, selected && styles.numberTextSelected]}>
                {i + 1}
              </Text>
            </View>
            <View style={styles.choiceText}>
              <Text style={styles.choiceTitle}>{choice.title}</Text>
              {choice.description ? <Text style={styles.muted}>{choice.description}</Text> : null}
            </View>
            {selected ? <Text style={styles.check}>✓</Text> : null}
          </Pressable>
        );
      })}
      {field.kind === "boolean" ? (
        <View style={styles.boolean}>
          <Text style={styles.choiceTitle}>{field.title ?? "Yes"}</Text>
          <Switch
            value={values[field.key] === true}
            disabled={disabled}
            onValueChange={(on) => onSet(field.key, on)}
            accessibilityLabel={field.title ?? "Yes"}
            testID="request__switch"
          />
        </View>
      ) : null}
      {inputField ? (
        <TextInput
          keyboardAppearance={scheme}
          value={text}
          editable={!disabled}
          onChangeText={(t) => onSet(inputField.key, t)}
          placeholder={note ? "Something else" : "Type your answer…"}
          placeholderTextColor={colors.faint}
          keyboardType={inputField.kind === "number" ? "numbers-and-punctuation" : "default"}
          autoCorrect={false}
          autoCapitalize={inputField.kind === "number" ? "none" : "sentences"}
          accessibilityLabel={field.title ?? field.description ?? "Answer"}
          style={[styles.textInput, error ? styles.textInputError : null]}
          testID="request__input"
        />
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" testID="request__field-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", gap: 8, justifyContent: "space-between" },
  headerText: { flex: 1, gap: 4 },
  question: { color: colors.foreground, fontSize: 17, fontWeight: "600", lineHeight: 23 },
  muted: { color: colors.mutedForeground, fontSize: 14 },
  pager: { alignItems: "center", flexDirection: "row", gap: 4 },
  pagerButton: { alignItems: "center", height: 32, justifyContent: "center", width: 28 },
  pagerText: { color: colors.mutedForeground, fontSize: 20 },
  pagerCount: { color: colors.mutedForeground, fontSize: 13 },
  dim: { opacity: 0.4 },
  stepBody: { gap: 6 },
  choice: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  choiceSelected: { borderColor: colors.foreground },
  number: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  numberSelected: { backgroundColor: colors.foreground, borderColor: colors.foreground },
  numberText: { color: colors.foreground, fontSize: 14 },
  numberTextSelected: { color: colors.background },
  choiceText: { flex: 1, gap: 2 },
  choiceTitle: { color: colors.foreground, fontSize: 15 },
  check: { color: tones.success, fontSize: 16 },
  boolean: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  textInput: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.foreground,
    fontSize: 16,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  textInputError: { borderColor: colors.destructive },
  error: { color: colors.destructive, fontSize: 14 },
  buttons: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  button: { minWidth: 96 },
});
