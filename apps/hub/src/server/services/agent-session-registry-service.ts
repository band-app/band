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

import { randomUUID } from "node:crypto";
import { createLogger } from "@band-app/logger";
import type { AgentMode, AgentSessionRecord } from "@band-app/shared/agent-sessions";
import { AgentSessionQueries } from "../infra/db/queries/agent-sessions";
import { subscribe } from "../infra/events/status-event-bus";
import { emit } from "./watcher-service";

const log = createLogger("agent-sessions");

export interface CreateAgentSessionInput {
  workspaceId: string;
  agentDefinitionId: string;
  mode: AgentMode;
  chatId?: string;
  terminalId?: string;
  providerSessionId?: string;
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
        this.endForTerminal(event.terminalId);
      }
    });
  }

  get(id: string): AgentSessionRecord | undefined {
    return this.queries.find(id);
  }

  /** Sessions of a workspace that haven't ended. */
  listOpen(workspaceId: string): AgentSessionRecord[] {
    return this.queries.findOpenByWorkspace(workspaceId);
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
      workspaceId: input.workspaceId,
      agentDefinitionId: input.agentDefinitionId,
      providerSessionId: input.providerSessionId ?? null,
      mode: input.mode,
      chatId: input.chatId ?? null,
      terminalId: input.terminalId ?? null,
      state: input.providerSessionId ? "running" : "starting",
      createdAt: now,
      updatedAt: now,
    };
    this.queries.insert(record);
    emit({ kind: "agent-session-created", workspaceId: record.workspaceId, agentSession: record });
    log.info(
      { agentSessionId: record.id, workspaceId: record.workspaceId, mode: record.mode },
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
    chat: { id: string; workspaceId: string; agent: string },
    providerSessionId: string | undefined,
  ): void {
    const open = this.queries.findOpenByChat(chat.id);
    if (open && open.providerSessionId === providerSessionId) return;
    if (open && open.providerSessionId === null) {
      if (providerSessionId) this.update(open.id, { providerSessionId, state: "running" });
      return;
    }
    if (open) this.end(open.id);
    if (!providerSessionId) return;
    this.create({
      workspaceId: chat.workspaceId,
      agentDefinitionId: chat.agent,
      mode: "gui",
      chatId: chat.id,
      providerSessionId,
    });
  }

  endForChat(chatId: string): void {
    const open = this.queries.findOpenByChat(chatId);
    if (open) this.end(open.id);
  }

  endForTerminal(terminalId: string): void {
    const open = this.queries.findOpenByTerminal(terminalId);
    if (open) this.end(open.id);
  }

  end(id: string): void {
    const ended = this.queries.update(id, { state: "ended", updatedAt: Date.now() });
    if (!ended) return;
    emit({ kind: "agent-session-ended", workspaceId: ended.workspaceId, agentSession: ended });
  }

  /** Drop every row of a deleted workspace. */
  removeAllForWorkspace(workspaceId: string): void {
    this.queries.deleteForWorkspace(workspaceId);
  }

  private update(
    id: string,
    patch: Pick<Partial<AgentSessionRecord>, "providerSessionId" | "state">,
  ): void {
    const updated = this.queries.update(id, { ...patch, updatedAt: Date.now() });
    if (!updated) return;
    emit({
      kind: "agent-session-updated",
      workspaceId: updated.workspaceId,
      agentSession: updated,
    });
  }
}

export const agentSessionRegistry = new AgentSessionRegistryService();
