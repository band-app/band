/**
 * Which tools of a proxied MCP server an agent may see and call (plan step
 * 4.2). Pure: the proxy asks, this answers. A tool must be in `allowTools`
 * (when the list is set). With `readOnly` on, it must also be named in
 * `readOnlyTools` or carry the `readOnlyHint` annotation, which the upstream
 * server supplies in `tools/list`.
 */

export interface ToolPolicy {
  allowTools: string[] | null;
  readOnly: boolean;
  readOnlyTools: string[];
}

export type CallDecision = "allow" | "deny" | "unknown";

/** `readOnlyHint` is true only when the server says so with a boolean. */
export function readOnlyHintOf(tool: unknown): boolean {
  if (tool === null || typeof tool !== "object") return false;
  const annotations = (tool as { annotations?: unknown }).annotations;
  if (annotations === null || typeof annotations !== "object") return false;
  return (annotations as { readOnlyHint?: unknown }).readOnlyHint === true;
}

/** Whether a tool from a `tools/list` result stays in the answer. */
export function listedToolAllowed(policy: ToolPolicy, tool: unknown): boolean {
  const name = tool !== null && typeof tool === "object" ? (tool as { name?: unknown }).name : null;
  if (typeof name !== "string") return false;
  if (policy.allowTools && !policy.allowTools.includes(name)) return false;
  if (!policy.readOnly) return true;
  return policy.readOnlyTools.includes(name) || readOnlyHintOf(tool);
}

/**
 * Whether a `tools/call` may go upstream. `knownReadOnly` is what an earlier
 * `tools/list` showed for the tool, or undefined when the proxy hasn't seen it.
 * `unknown` means the caller must look the tool up before deciding.
 */
export function decideCall(
  policy: ToolPolicy,
  name: string,
  knownReadOnly: boolean | undefined,
): CallDecision {
  if (policy.allowTools && !policy.allowTools.includes(name)) return "deny";
  if (!policy.readOnly || policy.readOnlyTools.includes(name)) return "allow";
  if (knownReadOnly === undefined) return "unknown";
  return knownReadOnly ? "allow" : "deny";
}
