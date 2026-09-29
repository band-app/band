import { Button, cn } from "@band-app/ui";
import {
  ArrowRight,
  CheckIcon,
  Loader2,
  MessageCircleQuestionMark,
  PencilIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
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

function isAnswered(step: Step, values: Record<string, Value>): boolean {
  return (
    values[step.field.key] !== undefined || (!!step.note && values[step.note.key] !== undefined)
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-sans text-xs text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * An ACP form elicitation: the agent needs structured input from the user,
 * such as Claude Code's AskUserQuestion (one select field per question, each
 * with its own optional free-text box). Shows one question at a time with a
 * stepper of all of them. Next moves on and, on the last question, sends
 * `accept` with the values; Skip all sends `decline`.
 *
 * Keys: a number picks that option, Enter goes to the next question, Esc
 * skips the current one.
 */
export function ElicitationForm({
  entry,
  agentLabel,
  onAnswer,
}: {
  entry: ElicitationEntry;
  /** The chat's agent as named in Settings > Coding agents. */
  agentLabel?: string;
  onAnswer: (action: "accept" | "decline", content?: Record<string, Value>) => Promise<void>;
}) {
  const fields = useMemo(() => fieldsOf(entry), [entry]);
  const steps = useMemo(() => stepsOf(fields), [fields]);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [index, setIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const answered = entry.answer !== undefined;
  const disabled = answered || sending;
  const step = steps[index] as Step | undefined;
  const isLast = index >= steps.length - 1;
  const agentName = agentLabel?.trim() || "The agent";

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
      setSending(true);
      try {
        await onAnswer(action, action === "accept" ? toContent(fields, from) : undefined);
      } finally {
        setSending(false);
      }
    },
    [onAnswer, fields],
  );

  const next = useCallback(
    (from: Record<string, Value> = values) => {
      if (disabled) return;
      if (isLast) void submit("accept", from);
      else setIndex((i) => i + 1);
    },
    [disabled, isLast, submit, values],
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
      const current = values[field.key];
      if (field.kind === "single") {
        set(field.key, current === choice.value ? undefined : choice.value);
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
    [values, set],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !step || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const typing = target instanceof HTMLInputElement && target.type !== "checkbox";
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      skip();
    } else if (e.key === "Enter") {
      // Other buttons (Back, Skip all, Next) keep their own Enter.
      if (target.tagName === "BUTTON" && !target.hasAttribute("data-choice")) return;
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      next();
    } else if (!typing && /^[1-9]$/.test(e.key)) {
      const choice = step.field.choices[Number(e.key) - 1];
      if (!choice) return;
      e.preventDefault();
      pick(step.field, choice);
    }
  };

  const heading = `${agentName} has ${steps.length === 1 ? "a question" : `${steps.length} questions`}`;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="chat-pane__elicitation"
      data-answered={answered ? "true" : "false"}
      className="not-prose overflow-hidden rounded-xl border border-border bg-card outline-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5 text-base font-medium">
          <MessageCircleQuestionMark className="size-4.5 shrink-0 text-muted-foreground" />
          <span data-testid="chat-pane__elicitation-heading">{heading}</span>
        </div>
        {steps.length > 1 && (
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            {steps.map((s, i) => {
              const state =
                i === index && !answered ? "current" : isAnswered(s, values) ? "done" : "upcoming";
              return (
                <li
                  key={s.field.key}
                  data-testid="chat-pane__elicitation-step"
                  data-state={state}
                  aria-current={state === "current" ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-2.5 py-1",
                    state === "current" && "bg-muted font-medium text-foreground",
                    state === "done" && "text-foreground",
                    state === "upcoming" && "text-muted-foreground",
                  )}
                >
                  {state === "done" ? <CheckIcon className="size-3.5" /> : <span>{i + 1}</span>}
                  {s.field.title ?? `Question ${i + 1}`}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {!answered && step && (
        <StepBody
          step={step}
          message={steps.length === 1 ? entry.request.message : undefined}
          values={values}
          disabled={disabled}
          onPick={pick}
          onSet={set}
        />
      )}
      {answered && (
        <Summary
          steps={steps}
          values={values}
          single={steps.length === 1}
          message={entry.request.message}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/40 px-4 py-3">
        {answered ? (
          <span className="text-sm text-muted-foreground">
            {entry.answer === "accept"
              ? "Answer sent to the agent"
              : entry.answer === "decline"
                ? "Skipped"
                : "Not answered"}
          </span>
        ) : (
          <>
            <div className="hidden items-center gap-1.5 text-sm text-muted-foreground sm:flex">
              {step && step.field.choices.length > 0 && (
                <>
                  <Kbd>
                    {step.field.choices.length === 1
                      ? "1"
                      : `1–${Math.min(step.field.choices.length, 9)}`}
                  </Kbd>
                  <span className="mr-1.5">pick</span>
                </>
              )}
              <Kbd>↵</Kbd>
              <span className="mr-1.5">{isLast ? "submit" : "next"}</span>
              <Kbd>Esc</Kbd>
              <span>skip</span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => void submit("decline", values)}
              >
                {steps.length > 1 ? "Skip all" : "Skip"}
              </Button>
              {steps.length > 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || index === 0}
                  onClick={() => setIndex((i) => Math.max(0, i - 1))}
                >
                  Back
                </Button>
              )}
              <Button size="sm" disabled={disabled} onClick={() => next()}>
                {sending && <Loader2 className="size-3.5 animate-spin" />}
                {isLast ? "Submit" : "Next"}
                {!isLast && <ArrowRight className="size-3.5" />}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StepBody({
  step,
  message,
  values,
  disabled,
  onPick,
  onSet,
}: {
  step: Step;
  /** The form's message, shown as the question when there is only one. */
  message?: string;
  values: Record<string, Value>;
  disabled: boolean;
  onPick: (field: Field, choice: Choice) => void;
  onSet: (key: string, value: Value | undefined) => void;
}) {
  const { field, note } = step;
  const question = message ?? field.description ?? field.title ?? field.key;
  // With a single question the description isn't the question, so it's a hint.
  const detail = message ? field.description : undefined;
  const hint =
    field.kind === "single" ? "Pick one" : field.kind === "multi" ? "Pick any" : undefined;
  const current = values[field.key];
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : "");

  return (
    <div className="space-y-3 px-5 py-4">
      <div className="space-y-1">
        <p data-testid="chat-pane__elicitation-question" className="text-sm font-semibold">
          {question}
        </p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>

      {field.choices.length > 0 && (
        <fieldset aria-label={question} className="space-y-2">
          {field.choices.map((choice, i) => {
            const selected = Array.isArray(current)
              ? current.includes(choice.value)
              : current === choice.value;
            const descriptionId = choice.description
              ? `${field.key}-${choice.value}-description`
              : undefined;
            return (
              <button
                key={choice.value}
                type="button"
                data-choice=""
                aria-pressed={selected}
                aria-label={choice.title}
                aria-describedby={descriptionId}
                disabled={disabled}
                onClick={() => onPick(field, choice)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  selected
                    ? "border-foreground bg-muted/40 ring-1 ring-foreground"
                    : "border-border bg-background hover:bg-muted/50",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-medium",
                    selected ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
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
            );
          })}
        </fieldset>
      )}

      {field.kind === "boolean" && (
        <label className="flex w-full items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
          <input
            type="checkbox"
            disabled={disabled}
            checked={values[field.key] === true}
            onChange={(e) => onSet(field.key, e.target.checked)}
          />
          <span className="text-sm">{field.title ?? "Yes"}</span>
        </label>
      )}

      {(field.kind === "text" || field.kind === "number" || note) && (
        <label className="flex w-full items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 focus-within:border-foreground">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <PencilIcon className="size-3.5" />
          </span>
          {/* A number is kept as typed ("-", "1.") and converted on submit. */}
          <input
            type={field.kind === "number" ? "number" : "text"}
            data-testid="chat-pane__elicitation-note"
            disabled={disabled}
            placeholder={note ? "Something else, or add a note…" : "Type your answer…"}
            value={text(note ? note.key : field.key)}
            onChange={(e) => onSet(note ? note.key : field.key, e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
      )}
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
    <dl className="space-y-2 px-5 py-4 text-sm">
      {rows.map((r) => (
        <div key={r.key}>
          <dt className="text-muted-foreground">{r.question}</dt>
          <dd className="font-medium">{r.answer}</dd>
        </div>
      ))}
    </dl>
  );
}
