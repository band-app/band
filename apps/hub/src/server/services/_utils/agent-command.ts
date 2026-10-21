/**
 * The one place that applies a worker's command override for a coding agent. Every path that
 * builds an agent definition for a host (chats, terminal sessions, cronjobs, one-shot calls,
 * model probes, usage readers, availability) calls `commandFor` or `withHostCommand` with the
 * target host id, so the override wins everywhere: the worker's override, then the definition's
 * `command`, then the agent's default binary (chosen on the worker).
 */

import { TokenQueries } from "../../infra/db/queries/tokens";

const hosts = new TokenQueries();

/** The override stored for an agent on a host, or undefined. */
export function overrideFor(hostId: string, agentId: string): string | undefined {
  const value = hosts.findHost(hostId)?.agentCommands?.[agentId];
  return value || undefined;
}

/** The command an agent runs on a host: the host's override, else the definition's own. */
export function commandFor(
  hostId: string,
  def: { id: string; command?: string },
): string | undefined {
  return overrideFor(hostId, def.id) ?? def.command;
}

/** The definition with the host's command in place of its own. */
export function withHostCommand<T extends { id: string; command?: string }>(
  hostId: string,
  def: T,
): T {
  const command = commandFor(hostId, def);
  return command === def.command ? def : { ...def, command };
}

/** A binary name or an absolute path. No arguments, so nothing the hub sends can be a shell line. */
export function checkAgentCommand(command: string): string {
  const value = command.trim();
  if (!value) throw new Error("The command is empty");
  if (value.length > 4096) throw new Error("The command is too long");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("The command has control characters");
  if (/\s/.test(value) || /[;&|<>`$"'\\*?(){}[\]!#~]/.test(value)) {
    throw new Error("Use a binary name or a path only, with no arguments or shell characters");
  }
  if (value.includes("/") && !value.startsWith("/")) {
    throw new Error("A path must be absolute");
  }
  if (value.startsWith("-")) throw new Error("The command cannot start with a dash");
  if (value.split("/").some((part) => part === "..")) {
    throw new Error("A path cannot contain ..");
  }
  return value;
}

/** A launch failure with the worker it happened on, for a message that names both. */
export function launchFailure(hostId: string, message: string): string {
  const name = hosts.findHost(hostId)?.name;
  return name ? `${message} (worker ${name})` : message;
}
