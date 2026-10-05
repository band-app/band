import { createLogger } from "@band-app/logger";
import { WorktreeNotFoundError } from "../errors";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("session-service");

/**
 * Past sessions for a chat pane's history dropdown (issue #648).
 *
 * Sessions belong to the coding agent. Agents that support ACP
 * `session/list` answer for themselves; for the rest (Gemini CLI, Cursor
 * CLI) Band's own chat event log stands in, listing the sessions Band ran.
 * The API tier (`server/api/sessions/router.ts`) delegates here.
 */

export { WorktreeNotFoundError };

export interface SessionSummary {
  sessionId: string;
  summary: string;
  lastModified: number;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
  /** Always true since #648: agents without `session/list` fall back to
   *  Band's own log. Kept so existing clients' checks keep working. */
  supported: boolean;
}

export class SessionService {
  /** Lists past sessions for a worktree's chat pane (default chat when
   *  `chatId` is undefined). */
  async list(input: { worktreeId: string; chatId?: string }): Promise<ListSessionsResponse> {
    const worktree = worktreeService.resolve(input.worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(input.worktreeId);
    }
    const chatId = input.chatId ?? chatService.getOrCreateDefault(input.worktreeId).id;
    if (!chatService.get(chatId)) {
      chatService.create(input.worktreeId, { id: chatId, name: "Chat" });
    }
    log.debug({ chatId, worktreeId: input.worktreeId }, "listing past sessions for chat");
    return agentSessionService.listSessions(chatId);
  }
}

export const sessionService = new SessionService();
