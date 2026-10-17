/**
 * What the model, mode and other pickers of a chat show, read from the ACP session state the
 * hub streams. Agents with `model` / `mode` config options use them; others expose the legacy
 * model and mode state, which `__legacy_model` / `__legacy_mode` address on the server.
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { SessionState } from "@band-app/shared/chat-events";

import { withResolvedDefaults } from "./claude-default-labels.ts";

export interface Choice {
  id: string;
  name: string;
  description?: string;
}

export type SelectOption = Extract<SessionConfigOption, { type: "select" }>;

export function selectChoices(option: SelectOption): Choice[] {
  return option.options
    .flatMap((o) => ("group" in o ? o.options : [o]))
    .map((o) => ({ id: o.value, name: o.name, description: o.description ?? undefined }));
}

function findSelect(session: SessionState | null, category: "model" | "mode") {
  return session?.configOptions.find(
    (o): o is SelectOption => o.type === "select" && (o.category === category || o.id === category),
  );
}

/**
 * The model and mode pickers read ACP session config options (category
 * `model` / `mode`). Agents without them expose the legacy model and mode
 * state instead; `__legacy_model` / `__legacy_mode` tell the server to use
 * `session/set_model` / `session/set_mode`.
 */
export function sessionPickers(session: SessionState | null) {
  const modelOption = findSelect(session, "model");
  const modeOption = findSelect(session, "mode");
  const models: Choice[] = modelOption
    ? selectChoices(modelOption)
    : (session?.models?.availableModels ?? []).map((m) => ({
        id: m.modelId,
        name: m.name,
        description: m.description ?? undefined,
      }));
  const modes: Choice[] = modeOption
    ? selectChoices(modeOption)
    : (session?.modes?.availableModes ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? undefined,
      }));
  const rest = (session?.configOptions ?? []).filter(
    (o): o is SelectOption => o.type === "select" && o !== modelOption && o !== modeOption,
  );
  const fast = rest.find(isFastModeOption);
  const effort = rest.find(
    (o) => o !== fast && (o.category === "thought_level" || o.id === "effort"),
  );
  const model = modelOption ? String(modelOption.currentValue) : session?.models?.currentModelId;
  // Claude Code: name the "default" choices after what they run with.
  const labeled = session?.resolvedDefaults
    ? withResolvedDefaults(models, model, effort, session.resolvedDefaults)
    : { models, effort, effortLabel: undefined };
  return {
    models: labeled.models,
    model,
    modelConfigId: modelOption?.id ?? "__legacy_model",
    modes,
    mode: modeOption ? String(modeOption.currentValue) : session?.modes?.currentModeId,
    modeConfigId: modeOption?.id ?? "__legacy_mode",
    effort: labeled.effort,
    effortLabel: labeled.effortLabel,
    fast,
    // Everything else the agent lets the user choose.
    others: rest.filter((o) => o !== effort && o !== fast),
  };
}

/** Fast mode as an on/off select. Band doesn't advertise boolean config
 *  options, so agents (Claude Code's `fast`) fall back to this shape. */
export function isFastModeOption(option: SelectOption): boolean {
  if (option.id !== "fast") return false;
  const values = new Set(selectChoices(option).map((c) => c.id));
  return values.size === 2 && values.has("off") && values.has("on");
}
