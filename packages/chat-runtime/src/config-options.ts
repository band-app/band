/**
 * Session config options (ACP `SessionConfigOption`) as both chat runtimes
 * read them: the hub's and an owning worker's.
 */

import type * as acp from "@agentclientprotocol/sdk";

/** A choice of a select-type session config option, groups flattened. */
export interface ConfigChoice {
  id: string;
  name: string;
  description?: string;
}

/** The select option for a category (`model`, `mode`), by ACP category or
 *  by the id agents conventionally give it. */
export function findOption(
  options: acp.SessionConfigOption[],
  category: "model" | "mode",
): acp.SessionConfigOption | undefined {
  return options.find((o) => o.type === "select" && (o.category === category || o.id === category));
}

/** A select option's choices, flat or grouped, as one list. */
export function optionChoices(option: acp.SessionConfigOption): ConfigChoice[] {
  if (option.type !== "select") return [];
  return option.options
    .flatMap((o) => ("group" in o ? o.options : [o]))
    .map((o) => ({ id: o.value, name: o.name, description: o.description ?? undefined }));
}

export function selectValues(option: acp.SessionConfigOption): string[] {
  return optionChoices(option).map((c) => c.id);
}

/** Which saved chat setting a config change sets: the chat's model, its mode, or neither. */
export function configCategory(
  options: acp.SessionConfigOption[],
  configId: string,
): "model" | "mode" | undefined {
  const option = options.find((o) => o.id === configId);
  if (option?.category === "model" || configId === "model" || configId === "__legacy_model") {
    return "model";
  }
  if (option?.category === "mode" || configId === "mode" || configId === "__legacy_mode") {
    return "mode";
  }
  return undefined;
}
