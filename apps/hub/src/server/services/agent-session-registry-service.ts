/**
 * Agent session registry (issue #682).
 *
 * Owns the `agent_sessions` rows and the `agent-session-created` /
 * `agent-session-updated` / `agent-session-ended` events every client
 * listens to. It depends only on the queries and the event bus, so the chat
 * and terminal services can report into it without an import cycle.
 * Launching lives in `agent-launch-service.ts`.
 *
 * Distinct from `agent-session-service.ts`, which runs the ACP process
 * behind a chat pane.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createLogger } from "@band-app/logger";
import type {
  AgentMode,
  AgentSessionEndReason,
  AgentSessionRecord,
} from "@band-app/shared/agent-sessions";
import { AgentSessionQueries } from "../infra/db/queries/agent-sessions";
import { subscribe } from "../infra/events/status-event-bus";
import { emit } from "./watcher-service";

const log = createLogger("agent-sessions");

export interface CreateAgentSessionInput {
  worktreeId: string;
  agentDefinitionId: string;
  mode: AgentMode;
  chatId?: string;
  terminalId?: string;
  providerSessionId?: string;
  /** The launch token placed in the agent's PTY env; only its hash is stored. */
  launchToken?: string;
}

/** A coding-agent hook event seen in a Band terminal. */
export interface TerminalHookEvent {
  worktreeId: string;
  terminalId: string;
  /** The definition id the session shows under. */
  agentDefinitionId: string;
  /** The agent's own session id, when the payload carried one. */
  providerSessionId: string | null;
  /** `BAND_AGENT_LAUNCH_TOKEN` of the agent's process, when `band notify` forwarded it. */
  launchToken?: string;
  /** The agent said its session is over. */
  sessionEnd: boolean;
}

/** A fresh secret for one TUI launch. */
export function newLaunchToken(): string {
  return randomBytes(24).toString("hex");
}

function hashLaunchToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AgentSessionRegistryService {
  private stopListening: (() => void) | undefined;

  constructor(private readonly queries: AgentSessionQueries = new AgentSessionQueries()) {}

  /**
   * End sessions whose tab goes away. Called once at boot; the chat and
   * terminal services already announce removals on the event bus.
   */
  start(): void {
    if (this.stopListening) return;
    this.stopListening = subscribe((event) => {
      if (event.kind === "chat-removed" && event.chatId) {
        this.endForChat(event.chatId);
      } else if (event.kind === "terminal-killed" && event.terminalId) {
        this.endForTerminal(event.terminalId, "killed");
      }
    });
  }

  get(id: string): AgentSessionRecord | undefined {
    return this.queries.find(id);
  }

  /** Sessions of a worktree that haven't ended; every worktree's with no id. */
  listOpen(worktreeId?: string): AgentSessionRecord[] {
    return worktreeId ? this.queries.findOpenByWorktree(worktreeId) : this.queries.findAllOpen();
  }

  /** The newest session a terminal had, open or not. */
  latestForTerminal(terminalId: string): AgentSessionRecord | undefined {
    return this.queries.findLatestByTerminal(terminalId);
  }

  findOpenByChat(chatId: string): AgentSessionRecord | undefined {
    return this.queries.findOpenByChat(chatId);
  }

  findOpenByTerminal(terminalId: string): AgentSessionRecord | undefined {
    return this.queries.findOpenByTerminal(terminalId);
  }

  create(input: CreateAgentSessionInput): AgentSessionRecord {
    const now = Date.now();
    const record: AgentSessionRecord = {
      id: randomUUID(),
      worktreeId: input.worktreeId,
      agentDefinitionId: input.agentDefinitionId,
      providerSessionId: input.providerSessionId ?? null,
      mode: input.mode,
      chatId: input.chatId ?? null,
      terminalId: input.terminalId ?? null,
      state: input.providerSessionId ? "running" : "starting",
      endReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.queries.insert(record, input.launchToken ? hashLaunchToken(input.launchToken) : undefined);
    emit({ kind: "agent-session-created", worktreeId: record.worktreeId, agentSession: record });
    log.info(
      { agentSessionId: record.id, worktreeId: record.worktreeId, mode: record.mode },
      "agent session created",
    );
    return record;
  }

  /**
   * Record the provider session a chat pane is showing. The first id fills
   * in the pane's open session. A different id means the pane moved on to
   * another conversation, which is a new session. A chat that predates
   * agent sessions gets its row here, the first time its id is known.
   */
  recordChatProviderSession(
    chat: { id: string; worktreeId: string; agent: string },
    providerSessionId: string | undefined,
  ): void {
    const open = this.queries.findOpenByChat(chat.id);
    if (open && open.providerSessionId === providerSessionId) return;
    if (open && open.providerSessionId === null) {
      if (providerSessionId) this.update(open.id, { providerSessionId, state: "running" });
      return;
    }
    if (open) this.end(open.id, "replaced");
    if (!providerSessionId) return;
    this.create({
      worktreeId: chat.worktreeId,
      agentDefinitionId: chat.agent,
      mode: "gui",
      chatId: chat.id,
      providerSessionId,
    });
  }

  endForChat(chatId: string): void {
    const open = this.queries.findOpenByChat(chatId);
    if (open) this.end(open.id, "removed");
  }

  endForTerminal(terminalId: string, reason: AgentSessionEndReason): void {
    const open = this.queries.findOpenByTerminal(terminalId);
    if (open) this.end(open.id, reason);
  }

  /**
   * Apply a hook event from an agent in a Band terminal. Every agent that
   * reports through hooks gets a `tui` session, launched by Band or typed by
   * hand; the row is created once and its provider session id filled in.
   *
   * - A launched row (it has a launch token) takes its provider session id
   *   only from an event that carries the token, so a stray event from that
   *   terminal never claims the launch's identity.
   * - A different provider session id from the same terminal means the
   *   agent started a new conversation (`/clear`, a new run): the open row
   *   ends and a new one opens.
   * - `sessionEnd` ends the row.
   *
   * Returns the session the event belongs to, or null when it ended one or
   * was refused.
   */
  recordTerminalHook(event: TerminalHookEvent): AgentSessionRecord | null {
    const open = this.queries.findOpenByTerminal(event.terminalId);
    const tokenHash = event.launchToken ? hashLaunchToken(event.launchToken) : null;
    if (event.sessionEnd) {
      if (
        open &&
        (!event.providerSessionId ||
          open.providerSessionId === event.providerSessionId ||
          open.providerSessionId === null)
      ) {
        this.end(open.id, "session-end");
      }
      return null;
    }
    if (open) {
      if (!event.providerSessionId || open.providerSessionId === event.providerSessionId) {
        return open;
      }
      if (open.providerSessionId === null) {
        const launched = this.queries.hasLaunchToken(open.id);
        if (launched && !(tokenHash && this.queries.launchTokenMatches(open.id, tokenHash))) {
          return null;
        }
        this.update(open.id, { providerSessionId: event.providerSessionId, state: "running" });
        return this.queries.find(open.id) ?? open;
      }
      this.end(open.id, "replaced");
    }
    return this.create({
      worktreeId: event.worktreeId,
      agentDefinitionId: event.agentDefinitionId,
      mode: "tui",
      terminalId: event.terminalId,
      providerSessionId: event.providerSessionId ?? undefined,
    });
  }

  end(id: string, reason: AgentSessionEndReason): void {
    const ended = this.queries.update(id, {
      state: "ended",
      endReason: reason,
      updatedAt: Date.now(),
    });
    if (!ended) return;
    emit({ kind: "agent-session-ended", worktreeId: ended.worktreeId, agentSession: ended });
  }

  /** Drop every row of a deleted worktree. */
  removeAllForWorktree(worktreeId: string): void {
    this.queries.deleteForWorktree(worktreeId);
  }

  private update(
    id: string,
    patch: Pick<Partial<AgentSessionRecord>, "providerSessionId" | "state">,
  ): void {
    const updated = this.queries.update(id, { ...patch, updatedAt: Date.now() });
    if (!updated) return;
    emit({
      kind: "agent-session-updated",
      worktreeId: updated.worktreeId,
      agentSession: updated,
    });
  }
}

export const agentSessionRegistry = new AgentSessionRegistryService();
