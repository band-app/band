/**
 * Per-turn token + cost snapshot for one session, read from the provider's
 * on-disk session storage (issue #425 — Reports dialog).
 *
 * Usage readers (`usage/`) walk their provider's session file once and
 * return the cumulative per-turn breakdown. The Reports
 * scanner upserts these into `usage_events` keyed by
 * `(provider, sessionId, turnIndex)` so re-reads are idempotent — a session
 * still being appended to is rescanned each tick and only the new turns
 * land as new rows.
 */
export interface SessionUsageTurn {
  /** 0-based ordinal within the session. Pairs with `sessionId` to form
   *  the dedup key the scanner uses (`external_key`). */
  turnIndex: number;
  /** Epoch ms when this turn was completed (provider timestamp). */
  capturedAt: number;
  /** Model id for this specific turn. May differ from `SessionUsageSnapshot.modelFallback`
   *  when the user switched models mid-session (Codex supports this). */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningOutputTokens?: number;
  /** Provider-reported USD cost when the provider exposes one
   *  (Claude `total_cost_usd`, OpenCode `part.cost`); otherwise computed
   *  from `tokens × MODEL_PRICING[model]` (Codex, Gemini). */
  costUsd: number;
}

export interface SessionUsageSnapshot {
  sessionId: string;
  /** Default model id when individual turns don't override it. */
  modelFallback: string;
  startedAt: number;
  updatedAt: number;
  turns: SessionUsageTurn[];
}

/**
 * Resolved vendor-CLI invocation for spawning the agent interactively in a
 * terminal pane (see `cli-invocation.ts`). Composed by `terminalService`
 * into a single shell command string with the prompt as the first positional
 * argument, so the CLI's REPL opens with the prompt already loaded
 * (cmux-style: `claude "<prompt>"`, `codex "<prompt>"`, etc.).
 *
 * `unsupported: true` is the sentinel returned when an agent has no vendor
 * CLI for the requested mode (Cursor CLI today, Gemini CLI for resume) or
 * the agent type is unknown. Callers fall back to the chat path rather than
 * spawning a terminal in that case.
 */
export type CliInvocation =
  | {
      command: string;
      args: string[];
      unsupported?: false;
    }
  | {
      command?: undefined;
      args?: undefined;
      unsupported: true;
      reason: string;
    };

/**
 * Workspace status an agent's lifecycle notification resolves to.
 *
 *   - `working`         → the agent is actively making progress.
 *   - `needs_attention` → the ball is in the user's court: the agent finished
 *                         its turn or is blocked waiting for the user to act.
 *
 * `hook-status.ts` owns the translation from each agent's notification/hook
 * payload to one of these values (e.g. `mapClaudeCodeHookStatus`), so adding
 * a new agent never requires touching the Band CLI.
 */
export type AgentHookStatus = "working" | "needs_attention";
