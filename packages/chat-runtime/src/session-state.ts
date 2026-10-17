/**
 * A session's settings read back from its event log, for a chat whose agent
 * is not running.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { SessionState } from "@band-app/shared/chat-events";

import type { ChatEventQueries, ChatEventRow } from "./log";

/**
 * The settings the session last had, from its log: the attach, then later
 * config and mode updates, the latest commands, usage and title. `commands`
 * fills in when the log has no commands update.
 */
export function sessionStateFromLog(
  events: ChatEventQueries,
  sessionId: string,
  revision: number,
  commands: acp.AvailableCommand[],
): SessionState {
  const latest = (match: Parameters<ChatEventQueries["latest"]>[2]) =>
    events.latest(sessionId, revision, match);
  const attached = latest({ kind: "session-attached" });
  const after = (row: ChatEventRow | undefined) =>
    row && (!attached || row.id > attached.id) ? row.event : undefined;
  const base = attached?.event.type === "session-attached" ? attached.event : undefined;
  const configUpdate = after(latest({ updateKind: "config_option_update" }));
  const modeUpdate = after(latest({ updateKind: "current_mode_update" }));
  const commandsUpdate = latest({ updateKind: "available_commands_update" })?.event;
  const usage = latest({ updateKind: "usage_update" })?.event;
  const info = latest({ updateKind: "session_info_update" })?.event;
  const modes = base?.modes ?? null;
  const usageUpdate =
    usage?.type === "update" && usage.update.sessionUpdate === "usage_update" ? usage.update : null;
  return {
    source: "log",
    configOptions:
      configUpdate?.type === "update" &&
      configUpdate.update.sessionUpdate === "config_option_update"
        ? configUpdate.update.configOptions
        : (base?.configOptions ?? []),
    modes:
      modes &&
      modeUpdate?.type === "update" &&
      modeUpdate.update.sessionUpdate === "current_mode_update"
        ? { ...modes, currentModeId: modeUpdate.update.currentModeId }
        : modes,
    models: base?.models ?? null,
    commands:
      commandsUpdate?.type === "update" &&
      commandsUpdate.update.sessionUpdate === "available_commands_update"
        ? commandsUpdate.update.availableCommands
        : commands,
    usage: usageUpdate,
    title:
      info?.type === "update" && info.update.sessionUpdate === "session_info_update"
        ? (info.update.title ?? null)
        : null,
  };
}

/** Band's running cost estimate for a session, from its last finished turn. */
export function loggedSessionCost(events: ChatEventQueries, sessionId: string): number | null {
  const revision = events.currentRevision(sessionId);
  if (revision === 0) return null;
  const row = events.latest(sessionId, revision, { kind: "turn-ended" });
  return row?.event.type === "turn-ended" ? (row.event.usage?.costUsd ?? null) : null;
}
