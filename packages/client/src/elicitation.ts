/**
 * An ACP form elicitation as steps the user answers one at a time: the pure half of the web's
 * `ElicitationForm` and the phone's, so both read a schema the same way. `fieldsOf` turns the
 * request's `requestedSchema` into fields, `stepsOf` groups a free-text "Other" box with its
 * question, `toContent` builds the answer, and `validateStep` says what is wrong with the
 * values typed so far.
 */

import type { Entry } from "./transcript.ts";

export type ElicitationEntry = Extract<Entry, { kind: "elicitation" }>;
export type ElicitationValue = string | number | boolean | string[];
export type ElicitationValues = Record<string, ElicitationValue>;

export interface Choice {
  value: string;
  title: string;
  description?: string;
}

export interface Field {
  key: string;
  title?: string;
  description?: string;
  kind: "single" | "multi" | "text" | "number" | "boolean";
  choices: Choice[];
  /** The schema lists the key under `required`. */
  required: boolean;
  /** A number field that takes whole numbers only (`type: "integer"`). */
  integer?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /**
   * Set on a free-text field that is another field's "Other" box: the key of the question it
   * belongs to.
   */
  customFor?: string;
}

/** One screen of the form: a question, plus its free-text box if it has one. */
export interface Step {
  field: Field;
  note?: Field;
}

/**
 * `_meta` marker the Claude Code and Codex ACP adapters put on the per-question free-text field
 * of an AskUserQuestion form.
 */
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

function bound(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function fieldsOf(entry: ElicitationEntry): Field[] {
  if (entry.request.mode !== "form") return [];
  const schema = (
    entry.request as {
      requestedSchema?: {
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      };
    }
  ).requestedSchema;
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([key, prop]) => {
    const base = {
      key,
      title: (prop.title as string | undefined) ?? undefined,
      description: (prop.description as string | undefined) ?? undefined,
      required: required.has(key),
    };
    if (prop.type === "array") {
      return { ...base, kind: "multi", choices: choicesOf(prop.items as Record<string, unknown>) };
    }
    if (prop.type === "boolean") return { ...base, kind: "boolean", choices: [] };
    if (prop.type === "number" || prop.type === "integer") {
      return {
        ...base,
        kind: "number",
        choices: [],
        integer: prop.type === "integer",
        min: bound(prop.minimum),
        max: bound(prop.maximum),
      };
    }
    const choices = choicesOf(prop);
    if (choices.length > 0) return { ...base, kind: "single", choices };
    return {
      ...base,
      kind: "text",
      choices: [],
      customFor: customFor(prop),
      minLength: bound(prop.minLength),
      maxLength: bound(prop.maxLength),
    };
  });
}

/**
 * Every field is a step, except a free-text box that belongs to a question in the form: that one
 * renders under its question.
 */
export function stepsOf(fields: Field[]): Step[] {
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
export function toContent(fields: Field[], values: ElicitationValues): ElicitationValues {
  const content: ElicitationValues = { ...values };
  for (const field of fields) {
    if (field.kind !== "number" || typeof content[field.key] !== "string") continue;
    const n = Number(content[field.key]);
    if (Number.isFinite(n)) content[field.key] = n;
    else delete content[field.key];
  }
  return content;
}

function isBlank(value: ElicitationValue | undefined): boolean {
  return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/** What is wrong with one field's value, or undefined. An empty optional field is fine. */
export function validateField(
  field: Field,
  value: ElicitationValue | undefined,
): string | undefined {
  if (isBlank(value)) return field.required ? "This is required" : undefined;
  if (field.kind === "number") {
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) return "Enter a number";
    if (field.integer && !Number.isInteger(n)) return "Enter a whole number";
    if (field.min !== undefined && n < field.min) return `Must be at least ${field.min}`;
    if (field.max !== undefined && n > field.max) return `Must be at most ${field.max}`;
  }
  if (field.kind === "text" && typeof value === "string") {
    if (field.minLength !== undefined && value.length < field.minLength) {
      return `Use at least ${field.minLength} characters`;
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      return `Use at most ${field.maxLength} characters`;
    }
  }
  return undefined;
}

/**
 * The errors of one step, by field key. A question that has a free-text box counts as answered
 * when either the pick or the text is there.
 */
export function validateStep(step: Step, values: ElicitationValues): Record<string, string> {
  const errors: Record<string, string> = {};
  const { field, note } = step;
  const answered = !isBlank(values[field.key]) || (note ? !isBlank(values[note.key]) : false);
  if (field.required && !answered) {
    errors[field.key] = "This is required";
  } else if (!isBlank(values[field.key])) {
    const error = validateField({ ...field, required: false }, values[field.key]);
    if (error) errors[field.key] = error;
  }
  if (note && !isBlank(values[note.key])) {
    const error = validateField({ ...note, required: false }, values[note.key]);
    if (error) errors[note.key] = error;
  }
  return errors;
}
