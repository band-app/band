import { Button, cn, Input } from "@band-app/ui";
import { CheckIcon, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
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
}

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
    return { ...base, kind: choices.length > 0 ? "single" : "text", choices };
  });
}

/**
 * An ACP form elicitation: the agent needs structured input from the user,
 * such as Claude Code's AskUserQuestion (one select field per question, plus
 * an optional free-text answer). Renders the schema's fields; Submit sends
 * `accept` with the values, Skip sends `decline`.
 */
export function ElicitationForm({
  entry,
  onAnswer,
}: {
  entry: ElicitationEntry;
  onAnswer: (action: "accept" | "decline", content?: Record<string, Value>) => Promise<void>;
}) {
  const fields = fieldsOf(entry);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [sending, setSending] = useState(false);
  const answered = entry.answer !== undefined;
  const disabled = answered || sending;

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
    async (action: "accept" | "decline") => {
      setSending(true);
      try {
        await onAnswer(action, action === "accept" ? values : undefined);
      } finally {
        setSending(false);
      }
    },
    [onAnswer, values],
  );

  return (
    <div
      data-testid="chat-pane__elicitation"
      data-answered={answered ? "true" : "false"}
      className="not-prose space-y-4 rounded-lg border border-border bg-card p-4"
    >
      <p className="text-base font-medium">{entry.request.message}</p>
      {fields.map((field) => (
        <div key={field.key} className="space-y-2">
          {field.title && (
            <span className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              {field.title}
            </span>
          )}
          {field.description && (
            <p className="text-sm text-muted-foreground">{field.description}</p>
          )}
          {(field.kind === "single" || field.kind === "multi") && (
            <div className="flex flex-wrap gap-2">
              {field.choices.map((choice) => {
                const current = values[field.key];
                const selected = Array.isArray(current)
                  ? current.includes(choice.value)
                  : current === choice.value;
                return (
                  <button
                    key={choice.value}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (field.kind === "single") {
                        set(field.key, selected ? undefined : choice.value);
                      } else {
                        const list = Array.isArray(current) ? current : [];
                        set(
                          field.key,
                          selected
                            ? list.filter((v) => v !== choice.value)
                            : [...list, choice.value],
                        );
                      }
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-base transition-colors",
                      selected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-foreground hover:bg-muted/50",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {selected && <CheckIcon className="size-3.5 shrink-0" />}
                    <div>
                      <div className="font-medium">{choice.title}</div>
                      {choice.description && (
                        <div className="text-sm text-muted-foreground">{choice.description}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {field.kind === "text" && (
            <Input
              disabled={disabled}
              value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
              onChange={(e) => set(field.key, e.target.value)}
            />
          )}
          {field.kind === "number" && (
            <Input
              type="number"
              disabled={disabled}
              value={typeof values[field.key] === "number" ? String(values[field.key]) : ""}
              onChange={(e) =>
                set(field.key, e.target.value === "" ? undefined : Number(e.target.value))
              }
            />
          )}
          {field.kind === "boolean" && (
            <input
              type="checkbox"
              disabled={disabled}
              checked={values[field.key] === true}
              onChange={(e) => set(field.key, e.target.checked)}
            />
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={disabled} onClick={() => void submit("accept")}>
          {sending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          {answered ? "Submitted" : "Submit"}
        </Button>
        {!answered && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void submit("decline")}
          >
            Skip
          </Button>
        )}
        {answered && (
          <span className="text-sm text-muted-foreground">
            {entry.answer === "accept"
              ? "Answer sent to the agent"
              : entry.answer === "decline"
                ? "Skipped"
                : "Not answered"}
          </span>
        )}
      </div>
    </div>
  );
}
