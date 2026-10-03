/**
 * Starts coding agents (issue #682). Every user-facing agent start goes
 * through `launch`, which picks the display from the mode: `gui` opens a
 * chat pane and submits the prompt over ACP, `tui` spawns the agent's CLI in
 * a terminal with the prompt pre-loaded. Either way it records an agent
 * session (`agent-session-registry-service.ts`).
 *
 * The mode comes from the caller. Browsers send their per-device mode;
 * callers without a device (the CLI, cronjobs, MCP) send nothing and get
 * `agents.defaultMode`.
 */

import { randomUUID } from "node:crypto";
import { cliInvocation } from "@band-app/coding-agent";
import { createLogger } from "@band-app/logger";
import type { AgentMode, AgentSessionRecord } from "@band-app/shared/agent-sessions";
import { WorkspaceNotFoundError } from "../errors";
import { formatShellCommand } from "./_utils/format-shell-command";
import { agentSessionRegistry } from "./agent-session-registry-service";
import { chatService } from "./chat-service";
import { settingsService } from "./settings-service";
import { taskService } from "./task-service";
import { terminalService } from "./terminal-service";
import { emit } from "./watcher-service";
import { workspaceService } from "./workspace-service";

const log = createLogger("agent-launch");

/** A launch named an existing chat that belongs to another workspace. */
export class ChatNotInWorkspaceError extends Error {
  constructor(chatId: string, workspaceId: string) {
    super(`Chat ${chatId} is not in workspace ${workspaceId}`);
    this.name = "ChatNotInWorkspaceError";
  }
}

export interface LaunchAgentInput {
  workspaceId: string;
  /** Agent definition id from `settings.codingAgents`; the default agent when omitted. */
  agentDefinitionId?: string;
  prompt?: string;
  /** `gui` or `tui`. Omitted means `agents.defaultMode`. */
  mode?: AgentMode;
  /**
   * Chat pane for a `gui` session. An existing chat is reused, so a
   * workspace's default chat can host its first prompt. A new id creates
   * the chat. Omitted means a fresh chat.
   */
  chatId?: string;
  /** Terminal id for a `tui` session. Omitted means a fresh UUID. */
  terminalId?: string;
  /** Model and permission mode for the first `gui` turn. */
  model?: string;
  permissionMode?: string;
}

export interface LaunchAgentResult {
  agentSession: AgentSessionRecord;
  /** The mode the session started in. Differs from the requested one after a fallback. */
  mode: AgentMode;
  chatId?: string;
  terminalId?: string;
  /** Why the requested mode wasn't used, e.g. an agent without a TUI invocation. */
  notice?: string;
  /**
   * Settles once the agent has started: the PTY is spawned for `tui`,
   * immediately for `gui` (the prompt runs as a task). Rejections are
   * already logged, so a caller that doesn't need to wait can ignore it.
   */
  ready: Promise<void>;
}

export class AgentLaunchService {
  launch(input: LaunchAgentInput): LaunchAgentResult {
    if (!workspaceService.resolve(input.workspaceId)) {
      throw new WorkspaceNotFoundError(input.workspaceId);
    }
    const agentDef = settingsService.getAgentDefinition(input.agentDefinitionId);
    const requested = input.mode ?? settingsService.defaultAgentMode();

    if (requested === "tui") {
      const invocation = cliInvocation(agentDef.type, input.prompt, { command: agentDef.command });
      if (!invocation.unsupported) {
        return this.launchTui(
          input,
          agentDef.id,
          formatShellCommand(invocation.command, invocation.args),
        );
      }
      log.warn(
        { workspaceId: input.workspaceId, agentId: agentDef.id, reason: invocation.reason },
        "agent has no TUI invocation; starting it in a chat",
      );
      return { ...this.launchGui(input, agentDef.id), notice: invocation.reason };
    }
    return this.launchGui(input, agentDef.id);
  }

  private launchGui(input: LaunchAgentInput, agentDefinitionId: string): LaunchAgentResult {
    const existing = input.chatId ? chatService.get(input.chatId) : undefined;
    if (existing && existing.workspaceId !== input.workspaceId) {
      throw new ChatNotInWorkspaceError(existing.id, input.workspaceId);
    }
    const chat =
      existing ??
      chatService.create(input.workspaceId, { id: input.chatId, agent: agentDefinitionId });
    // Submit first: a prompt for another agent switches the chat to it
    // synchronously, and the session row should name the agent that runs.
    if (input.prompt) {
      taskService.submitTask({
        workspaceId: input.workspaceId,
        chatId: chat.id,
        prompt: input.prompt,
        mode: input.permissionMode,
        model: input.model,
        codingAgentId: input.agentDefinitionId,
      });
    }
    const current = chatService.get(chat.id) ?? chat;
    const agentSession =
      agentSessionRegistry.findOpenByChat(chat.id) ??
      agentSessionRegistry.create({
        workspaceId: input.workspaceId,
        agentDefinitionId: current.agent,
        mode: "gui",
        chatId: chat.id,
        providerSessionId: current.activeSessionId,
      });
    return { agentSession, mode: "gui", chatId: chat.id, ready: Promise.resolve() };
  }

  private launchTui(
    input: LaunchAgentInput,
    agentDefinitionId: string,
    command: string,
  ): LaunchAgentResult {
    const { workspaceId } = input;
    const terminalId = input.terminalId ?? randomUUID();
    const agentSession = agentSessionRegistry.create({
      workspaceId,
      agentDefinitionId,
      mode: "tui",
      terminalId,
    });
    const ready = terminalService.spawn(workspaceId, terminalId, { command }).then(() => {
      emit({ kind: "terminal-created", workspaceId, terminalId });
    });
    ready.catch((err) => {
      agentSessionRegistry.end(agentSession.id);
      log.error(
        { err: err instanceof Error ? err.message : String(err), workspaceId, terminalId },
        "failed to spawn the agent's terminal",
      );
    });
    return { agentSession, mode: "tui", terminalId, ready };
  }
}

export const agentLaunchService = new AgentLaunchService();
