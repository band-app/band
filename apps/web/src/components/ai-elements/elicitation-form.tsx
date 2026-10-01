import { Button, cn } from "@band-app/ui";
import { CheckIcon, ChevronLeft, ChevronRight, Loader2, PencilIcon, XIcon } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Entry } from "../chat/transcript";

type ElicitationEntry = Extract<Entry, { kind: "elicitation" }>;
type Value = string | number | boolean | string[];

interface Choice {
  value: string;
  title: string;
  description?: string;
}

interface Field {
  key: string;
  title?: string;
  description?: string;
  kind: "single" | "multi" | "text" | "number" | "boolean";
  choices: Choice[];
  /** Set on a free-text field that is another field's "Other" box: the key
   *  of the question it belongs to. */
  customFor?: string;
}

/** One screen of the card: a question, plus its free-text box if it has one. */
interface Step {
  field: Field;
  note?: Field;
}

/** `_meta` marker the Claude Code and Codex ACP adapters put on the per-question
 *  free-text field of an AskUserQuestion form. */
const CUSTOM_ANSWER_META_KEY = "_askUserQuestionCustomAnswer";

/** The choices of an enum schema: titled `oneOf` / `anyOf`, or bare `enum`. */
function choicesOf(schema: Record<string, unknown> | undefined): Choice[] {
  if (!schema) return [];
  const titled = (schema.oneOf ?? schema.anyOf) as
    | { const: string; title?: string; description?: string | null }[]
    | undefined;
  if (Array.isArray(titled)) {
    return titled.map((o) => ({
      value: o.const,
      title: o.title ?? o.const,
      description: o.description ?? undefined,
    }));
  }
  const plain = schema.enum as string[] | undefined;
  return Array.isArray(plain) ? plain.map((v) => ({ value: v, title: v })) : [];
}

function customFor(prop: Record<string, unknown>): string | undefined {
  const meta = prop._meta as Record<string, { questionId?: unknown }> | undefined;
  const questionId = meta?.[CUSTOM_ANSWER_META_KEY]?.questionId;
  return typeof questionId === "string" ? questionId : undefined;
}

function fieldsOf(entry: ElicitationEntry): Field[] {
  if (entry.request.mode !== "form") return [];
  const schema = (
    entry.request as { requestedSchema?: { properties?: Record<string, Record<string, unknown>> } }
  ).requestedSchema;
  return Object.entries(schema?.properties ?? {}).map(([key, prop]) => {
    const base = {
      key,
      title: (prop.title as string | undefined) ?? undefined,
      description: (prop.description as string | undefined) ?? undefined,
    };
    if (prop.type === "array") {
      return { ...base, kind: "multi", choices: choicesOf(prop.items as Record<string, unknown>) };
    }
    if (prop.type === "boolean") return { ...base, kind: "boolean", choices: [] };
    if (prop.type === "number" || prop.type === "integer")
      return { ...base, kind: "number", choices: [] };
    const choices = choicesOf(prop);
    if (choices.length > 0) return { ...base, kind: "single", choices };
    return { ...base, kind: "text", choices: [], customFor: customFor(prop) };
  });
}

/** Every field is a step, except a free-text box that belongs to a question
 *  in the form: that one renders under its question. */
function stepsOf(fields: Field[]): Step[] {
  const keys = new Set(fields.map((f) => f.key));
  const steps: Step[] = [];
  for (const field of fields) {
    if (field.customFor && keys.has(field.customFor)) continue;
    const note = fields.find((f) => f.customFor === field.key);
    steps.push({ field, note });
  }
  return steps;
}

/** The answer content: number fields parsed, unparseable ones dropped. */
function toContent(fields: Field[], values: Record<string, Value>): Record<string, Value> {
  const content: Record<string, Value> = { ...values };
  for (const field of fields) {
    if (field.kind !== "number" || typeof content[field.key] !== "string") continue;
    const n = Number(content[field.key]);
    if (Number.isFinite(n)) content[field.key] = n;
    else delete content[field.key];
  }
  return content;
}

/**
 * An ACP form elicitation: the agent needs structured input from the user,
 * such as Claude Code's AskUserQuestion (one select field per question, each
 * with its own optional free-text box). Shows one question at a time as the
 * card's title, with a "‹ 2 of 3 ›" pager and an X that sends `decline`.
 *
 * Picking an option of a single-choice question moves on and, on the last
 * question, sends `accept` with the values. Multi-select, free-text and typed
 * "Something else" answers move on with Next (Submit on the last question) or
 * Enter. Skip leaves the question unanswered and moves on.
 *
 * Keys: ↑↓ move a highlight through the options and the "Something else"
 * row, Enter picks the highlighted option, a number picks that option, Esc
 * skips the current question (in the "Something else" box it only leaves
 * the box).
 */
export function ElicitationForm({
  entry,
  onAnswer,
}: {
  entry: ElicitationEntry;
  onAnswer: (action: "accept" | "decline", content?: Record<string, Value>) => Promise<void>;
}) {
  const fields = useMemo(() => fieldsOf(entry), [entry]);
  const steps = useMemo(() => stepsOf(fields), [fields]);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [index, setIndex] = useState(0);
  /** The highlighted row: an option, or `choices.length` for "Something else". */
  const [highlight, setHighlight] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  // `sending` only reaches the handlers on the next render; a repeated Enter
  // can arrive before that.
  const sendingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const answered = entry.answer !== undefined;
  const disabled = answered || sending;
  const step = steps[index] as Step | undefined;
  const isLast = index >= steps.length - 1;
  const single = steps.length === 1;
  // AskUserQuestion's message is boilerplate ("Please answer the following
  // questions."), but any other form's message is the context for its fields.
  const intro =
    steps.length > 1 && !fields.some((f) => f.customFor) ? entry.request.message : undefined;
  const hasInput =
    !!step && (step.field.kind === "text" || step.field.kind === "number" || !!step.note);
  const rowCount = step ? step.field.choices.length + (hasInput ? 1 : 0) : 0;
  // A single-choice pick moves on by itself; everything else needs a button.
  const needsNext =
    !!step &&
    (step.field.kind !== "single" || (!!step.note && values[step.note.key] !== undefined));

  // Take the keyboard when the questions arrive, unless the user is busy
  // somewhere else. The composer is disabled meanwhile, so it can't keep it.
  useEffect(() => {
    if (answered) return;
    const root = rootRef.current;
    if (!root || root.offsetParent === null) return;
    const active = document.activeElement;
    if (!active || active === document.body || active.hasAttribute("data-band-leaf-focus")) {
      root.focus({ preventScroll: true });
    }
  }, [answered]);

  const set = useCallback((key: string, value: Value | undefined) => {
    setValues((prev) => {
      const next = { ...prev };
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  }, []);

  const submit = useCallback(
    async (action: "accept" | "decline", from: Record<string, Value>) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      try {
        await onAnswer(action, action === "accept" ? toContent(fields, from) : undefined);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [onAnswer, fields],
  );

  const focusCard = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);

  const goTo = useCallback((i: number) => {
    // The new question replaces the rows, and with them a focused option or
    // the "Something else" box: keep the keyboard on the card.
    const root = rootRef.current;
    if (root?.contains(document.activeElement)) root.focus({ preventScroll: true });
    setIndex(i);
    setHighlight(null);
  }, []);

  const next = useCallback(
    (from: Record<string, Value> = values) => {
      if (disabled) return;
      if (isLast) void submit("accept", from);
      else goTo(index + 1);
    },
    [disabled, isLast, submit, values, goTo, index],
  );

  const skip = useCallback(() => {
    if (disabled || !step) return;
    const rest = { ...values };
    delete rest[step.field.key];
    if (step.note) delete rest[step.note.key];
    setValues(rest);
    next(rest);
  }, [disabled, step, values, next]);

  const pick = useCallback(
    (field: Field, choice: Choice) => {
      if (disabled) return;
      const current = values[field.key];
      if (field.kind === "single") {
        const from = { ...values, [field.key]: choice.value };
        setValues(from);
        next(from);
        return;
      }
      const list = Array.isArray(current) ? current : [];
      set(
        field.key,
        list.includes(choice.value)
          ? list.filter((v) => v !== choice.value)
          : [...list, choice.value],
      );
    },
    [disabled, values, set, next],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !step || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const typing = target instanceof HTMLInputElement && target.type !== "checkbox";
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // In the "Something else" box Esc only leaves the box, keeping the text.
      if (typing) rootRef.current?.focus({ preventScroll: true });
      else skip();
    } else if (e.key === "Enter") {
      // Buttons, option rows included, keep their own Enter.
      if (target.tagName === "BUTTON") return;
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      // A held Enter would run through the next questions unanswered.
      if (e.repeat) return;
      if (!typing && highlight !== null) {
        const choice = step.field.choices[highlight];
        if (choice) pick(step.field, choice);
        else inputRef.current?.focus();
        return;
      }
      // A single-choice question with nothing typed has no answer to move on
      // with: a stray Enter only starts the highlight, on the current pick.
      if (!needsNext) {
        if (!typing) {
          const picked = step.field.choices.findIndex((c) => c.value === values[step.field.key]);
          setHighlight(Math.max(0, picked));
        }
        return;
      }
      next();
    } else if (typing) {
      return;
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && rowCount > 0) {
      e.preventDefault();
      // An option row reached with Tab would otherwise keep Enter for itself.
      if (target !== rootRef.current) rootRef.current?.focus({ preventScroll: true });
      const down = e.key === "ArrowDown";
      setHighlight((h) =>
        h === null ? (down ? 0 : rowCount - 1) : (h + (down ? 1 : -1) + rowCount) % rowCount,
      );
    } else if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      const choice = step.field.choices[i];
      if (!choice) return;
      e.preventDefault();
      // A number key leaves the highlight where it is, so on a pick-any
      // question with nothing highlighted the next Enter moves on.
      pick(step.field, choice);
    }
  };

  // A form with no fields is only its message, answered with Submit.
  const question =
    step && !single
      ? (step.field.description ?? step.field.title ?? step.field.key)
      : entry.request.message;
  // With a single question the description isn't the question, so it's a hint.
  const detail = single ? step?.field.description : undefined;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="chat-pane__elicitation"
      data-answered={answered ? "true" : "false"}
      className="not-prose outline-none"
    >
      <div className="overflow-hidden rounded-2xl border border-border bg-muted/60">
        {answered ? (
          <>
            <p className="px-5 py-3 text-sm text-muted-foreground">
              {entry.answer === "accept"
                ? "Answer sent to the agent"
                : entry.answer === "decline"
                  ? "Skipped"
                  : "Not answered"}
            </p>
            <Summary
              steps={steps}
              values={values}
              single={single}
              message={entry.request.message}
            />
          </>
        ) : (
          <>
            <div className="flex items-start gap-3 pt-3 pr-3 pb-2 pl-5">
              <div className="min-w-0 flex-1 space-y-1 pt-1">
                {intro && <p className="text-sm text-muted-foreground">{intro}</p>}
                <p
                  data-testid="chat-pane__elicitation-question"
                  aria-live="polite"
                  className="text-lg leading-snug font-medium text-foreground"
                >
                  {question}
                </p>
                {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
                {step?.field.kind === "multi" && (
                  <p className="text-sm text-muted-foreground">Pick any</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
                {steps.length > 1 && (
                  <div className="flex items-center text-sm">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Previous question"
                      disabled={disabled || index === 0}
                      onClick={() => goTo(index - 1)}
                    >
                      <ChevronLeft />
                    </Button>
                    <span
                      data-testid="chat-pane__elicitation-step"
                      data-index={index + 1}
                      data-count={steps.length}
                      className="tabular-nums"
                    >
                      {index + 1} of {steps.length}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Next question"
                      disabled={disabled || isLast}
                      onClick={() => goTo(index + 1)}
                    >
                      <ChevronRight />
                    </Button>
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Dismiss questions"
                  disabled={disabled}
                  onClick={() => void submit("decline", values)}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            </div>
            {step ? (
              <StepBody
                step={step}
                question={question}
                values={values}
                disabled={disabled}
                sending={sending}
                highlight={highlight}
                hasInput={hasInput}
                needsNext={needsNext}
                isLast={isLast}
                inputRef={inputRef}
                onFocusCard={focusCard}
                onHighlight={setHighlight}
                onPick={pick}
                onSet={set}
                onSkip={skip}
                onNext={() => next()}
              />
            ) : (
              <div
                data-testid="chat-pane__elicitation-other"
                className="flex justify-end px-3 pb-3"
              >
                <Button size="sm" disabled={disabled} onClick={() => void submit("accept", {})}>
                  {sending && <Loader2 className="size-3.5 animate-spin" />}
                  Submit
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {!answered && step && (
        <p
          data-testid="chat-pane__elicitation-hint"
          className="mt-2 hidden text-center text-xs text-muted-foreground sm:block"
        >
          {rowCount > 0 && "↑↓ to navigate · "}Enter to select · Esc to skip
        </p>
      )}
    </div>
  );
}

function StepBody({
  step,
  question,
  values,
  disabled,
  sending,
  highlight,
  hasInput,
  needsNext,
  isLast,
  inputRef,
  onFocusCard,
  onHighlight,
  onPick,
  onSet,
  onSkip,
  onNext,
}: {
  step: Step;
  question: string;
  values: Record<string, Value>;
  disabled: boolean;
  sending: boolean;
  highlight: number | null;
  /** The bottom row has a free-text box: "Something else", or the answer. */
  hasInput: boolean;
  needsNext: boolean;
  isLast: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Puts the keyboard on the card, where ↑↓, numbers, Enter and Esc work. */
  onFocusCard: () => void;
  onHighlight: (row: number) => void;
  onPick: (field: Field, choice: Choice) => void;
  onSet: (key: string, value: Value | undefined) => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  const { field, note } = step;
  const idPrefix = useId();
  const current = values[field.key];
  const inputKey = note ? note.key : field.key;
  const text = typeof values[inputKey] === "string" ? (values[inputKey] as string) : "";

  return (
    <div className="px-3 pb-3">
      {field.choices.length > 0 && (
        <fieldset aria-label={question}>
          {field.choices.map((choice, i) => {
            const selected = Array.isArray(current)
              ? current.includes(choice.value)
              : current === choice.value;
            const descriptionId = choice.description
              ? `${idPrefix}-${field.key}-${i}-description`
              : undefined;
            return (
              <Fragment key={choice.value}>
                {i > 0 && (
                  <div
                    data-testid="chat-pane__elicitation-divider"
                    className="mx-2 h-px bg-border"
                  />
                )}
                <button
                  type="button"
                  data-choice=""
                  data-highlighted={highlight === i ? "true" : undefined}
                  aria-pressed={selected}
                  aria-label={choice.title}
                  aria-describedby={descriptionId}
                  disabled={disabled}
                  // A click puts the keyboard on the card, not on the row.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onFocusCard();
                  }}
                  onFocus={() => onHighlight(i)}
                  onClick={() => onPick(field, choice)}
                  className={cn(
                    "my-0.5 flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-foreground/5",
                    highlight === i && "bg-foreground/10 hover:bg-foreground/10",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <span
                    data-testid="chat-pane__elicitation-choice-number"
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg border text-sm tabular-nums",
                      selected
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-card text-foreground",
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{choice.title}</span>
                    {choice.description && (
                      <span id={descriptionId} className="block text-xs text-muted-foreground">
                        {choice.description}
                      </span>
                    )}
                  </span>
                  {selected && <CheckIcon className="size-4 shrink-0" />}
                </button>
              </Fragment>
            );
          })}
        </fieldset>
      )}

      {field.kind === "boolean" && (
        <label className="flex w-full items-center gap-3 rounded-lg px-2 py-2">
          <input
            type="checkbox"
            disabled={disabled}
            checked={values[field.key] === true}
            onChange={(e) => onSet(field.key, e.target.checked)}
          />
          <span className="text-sm">{field.title ?? "Yes"}</span>
        </label>
      )}

      <div
        data-testid="chat-pane__elicitation-other"
        data-highlighted={hasInput && highlight === field.choices.length ? "true" : undefined}
        className={cn(
          "mt-1 flex items-center gap-3 rounded-xl bg-background px-2 py-2",
          hasInput && highlight === field.choices.length && "ring-1 ring-ring",
          hasInput && "has-[input:focus]:ring-1 has-[input:focus]:ring-ring",
        )}
      >
        {hasInput ? (
          <label className="flex min-w-0 flex-1 items-center gap-3">
            <span
              data-testid="chat-pane__elicitation-other-icon"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground"
            >
              <PencilIcon className="size-3.5" />
            </span>
            {/* A number is kept as typed ("-", "1.") and converted on submit. */}
            <input
              ref={inputRef}
              type={field.kind === "number" ? "number" : "text"}
              data-testid="chat-pane__elicitation-note"
              disabled={disabled}
              placeholder={note ? "Something else" : "Type your answer…"}
              value={text}
              onFocus={() => onHighlight(field.choices.length)}
              onChange={(e) => onSet(inputKey, e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </label>
        ) : (
          <div className="flex-1" />
        )}
        {/* A single-choice pick sends from the row, with no Submit to spin. */}
        {sending && !needsNext && (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        )}
        <Button size="sm" variant="outline" disabled={disabled} onClick={onSkip}>
          Skip
        </Button>
        {needsNext && (
          <Button size="sm" disabled={disabled} onClick={onNext}>
            {sending && <Loader2 className="size-3.5 animate-spin" />}
            {isLast ? "Submit" : "Next"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** What the user sent, while this card still knows it (it isn't stored). */
function Summary({
  steps,
  values,
  single,
  message,
}: {
  steps: Step[];
  values: Record<string, Value>;
  single: boolean;
  message: string;
}) {
  const rows = steps.flatMap((s) => {
    const parts: string[] = [];
    const v = values[s.field.key];
    if (v !== undefined) {
      const titles = (Array.isArray(v) ? v : [v]).map(
        (x) => s.field.choices.find((c) => c.value === x)?.title ?? String(x),
      );
      parts.push(titles.join(", "));
    }
    if (s.note && typeof values[s.note.key] === "string") parts.push(values[s.note.key] as string);
    if (parts.length === 0) return [];
    const question = single ? message : (s.field.description ?? s.field.title ?? s.field.key);
    return [{ key: s.field.key, question, answer: parts.join(" · ") }];
  });
  if (rows.length === 0) return null;
  return (
    <dl className="divide-y divide-border border-t border-border px-5 text-sm">
      {rows.map((r) => (
        <div key={r.key} className="py-2.5">
          <dt className="text-muted-foreground">{r.question}</dt>
          <dd className="font-medium">{r.answer}</dd>
        </div>
      ))}
    </dl>
  );
}
