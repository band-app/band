// Labels for Claude Code's `default` model and effort choices. The Claude
// ACP adapter names them "Default (recommended)" and "Default", which hides
// what the session runs. The server resolves what they run with
// (`SessionState.resolvedDefaults`); this names it: the composer shows
// "Opus 5.5" and "Medium", and the row that goes back to the default reads
// "Default: Opus 5.5".
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { ResolvedDefaults } from "../../shared/chat-events";

export interface ModelChoice {
  id: string;
  name: string;
  description?: string;
}

type SelectOption = Extract<SessionConfigOption, { type: "select" }>;

const DEFAULT_ID = "default";

/** "claude-opus-5-5-20260101[1m]" → "Opus 5.5". Null for ids of another
 *  shape. */
export function claudeModelName(id: string): string | null {
  const m = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[\d+m\]|-\d+m)?$/i.exec(
    id.trim(),
  );
  if (!m?.[1] || !m[2]) return null;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** A model id or alias as the picker names it. */
function modelName(model: string, choices: ModelChoice[]): string {
  const choice = choices.find((c) => c.id === model && c.id !== DEFAULT_ID);
  return choice?.name ?? claudeModelName(model) ?? model;
}

/**
 * The picker model the adapter's own description of its default row names.
 * The adapter describes it with the CLI's short label ("Opus (1M context)"),
 * while its rows carry versioned names ("Opus 5.5"), so match on the family
 * and the 1M context window. Null unless exactly one row fits.
 */
function modelFromDescription(description: string, choices: ModelChoice[]): string | null {
  const others = choices.filter((c) => c.id !== DEFAULT_ID);
  const exact = others.find((c) => c.name === description);
  if (exact) return exact.name;
  const family = description.trim().split(/\s+/)[0]?.toLowerCase();
  if (!family) return null;
  const wants1m = /\b1m\b/i.test(description);
  const matches = others.filter(
    (c) =>
      (c.id.toLowerCase().includes(family) || c.name.toLowerCase().startsWith(family)) &&
      /\[1m\]/i.test(c.id) === wants1m,
  );
  return matches.length === 1 ? (matches[0]?.name ?? null) : null;
}

function relabel(option: SelectOption, value: string, name: string): SelectOption {
  const rename = <T extends { value: string; name: string }>(o: T): T =>
    o.value === value ? { ...o, name } : o;
  return {
    ...option,
    options: option.options.map((o) =>
      "group" in o ? { ...o, options: o.options.map(rename) } : rename(o),
    ),
  } as SelectOption;
}

function flatChoices(option: SelectOption): { value: string; name: string }[] {
  return option.options.flatMap((o) => ("group" in o ? o.options : [o]));
}

/**
 * Names the `default` model and effort choices after what they resolve to.
 *
 *   - Model: while `default` is selected, its row (the composer trigger and
 *     the top of the menu) reads the model, "Opus 5.5". Otherwise it sits in
 *     "More models" as "Default: Opus 5.5".
 *   - Effort: the `default` row reads "Default: Medium", and `effortLabel`
 *     is what the composer trigger shows while it is selected, "Medium".
 *
 * A default nothing resolves keeps a plain "Default" label, with the
 * adapter's own hint when it has one: "Default (Opus)".
 */
export function withResolvedDefaults(
  models: ModelChoice[],
  currentModel: string | undefined,
  effort: SelectOption | undefined,
  resolved: ResolvedDefaults,
): { models: ModelChoice[]; effort: SelectOption | undefined; effortLabel?: string } {
  const labeledModels = models.map((choice) => {
    if (choice.id !== DEFAULT_ID) return choice;
    const name = resolved.model
      ? modelName(resolved.model, models)
      : choice.description
        ? modelFromDescription(choice.description, models)
        : null;
    if (currentModel !== DEFAULT_ID) {
      // The name says it all; the adapter's description may name another model.
      return { id: choice.id, name: name ? `Default: ${name}` : "Default" };
    }
    return {
      ...choice,
      name: name ?? (choice.description ? `Default (${choice.description})` : "Default"),
      description: "Follows your Claude Code default",
    };
  });

  if (!effort || !flatChoices(effort).some((c) => c.value === DEFAULT_ID)) {
    return { models: labeledModels, effort };
  }
  const level = resolved.effort;
  const levelName = level
    ? (flatChoices(effort).find((c) => c.value === level)?.name ??
      level.charAt(0).toUpperCase() + level.slice(1))
    : undefined;
  return {
    models: labeledModels,
    effort: relabel(effort, DEFAULT_ID, levelName ? `Default: ${levelName}` : "Default"),
    effortLabel: effort.currentValue === DEFAULT_ID ? (levelName ?? "Default") : undefined,
  };
}
