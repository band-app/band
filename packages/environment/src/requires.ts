import { satisfies } from "./versions.ts";

export interface UnmetRequirement {
  tool: string;
  /** The range the environment asks for. */
  range: string;
  /** The version the host has, or `null` when it has none. */
  found: string | null;
}

/** Names `requires` may use for a tool that the host reports under another key. */
const ALIASES: Record<string, string> = { python3: "python", nodejs: "node" };

/**
 * The entries of `requires` a host does not meet. `tools` maps a tool name to
 * the version the host has (`HostInfo.tools`). An empty list means the host
 * meets every requirement.
 */
export function unmetRequirements(
  requires: Record<string, string> | undefined,
  tools: Record<string, string> | undefined,
): UnmetRequirement[] {
  const unmet: UnmetRequirement[] = [];
  for (const [tool, range] of Object.entries(requires ?? {})) {
    const found = tools?.[tool] ?? tools?.[ALIASES[tool] ?? tool] ?? null;
    if (found === null || !satisfies(found, range)) unmet.push({ tool, range, found });
  }
  return unmet;
}
