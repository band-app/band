/**
 * Pieces of a prompt turn both chat runtimes share: the usage the `turn-ended`
 * event logs, the prompt's file links and the stop reasons that count as failed.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { computeCost } from "@band-app/coding-agent";
import type { TurnUsage } from "@band-app/shared/chat-events";

export interface TurnUsageContext {
  /** The model the live session uses. */
  model: string | undefined;
  /** The agent's own cumulative session cost in USD, when it reports one. */
  reportedCost: number | undefined;
  /** The session's cost before this turn: the agent's figure or Band's estimate. */
  previousCost: number | null;
}

/**
 * Token usage for the finished turn. `PromptResponse.usage` is the ACP
 * field (Claude Code: the whole turn; Codex: the turn's last model call);
 * Gemini CLI reports the turn's tokens only in `_meta.quota.token_count`.
 * The cost is the agent's own cumulative figure when it sends one
 * (`usage_update.cost`, Claude Code), else the previous estimate plus this
 * turn priced from `MODEL_PRICING`.
 */
export function turnUsage(res: acp.PromptResponse, ctx: TurnUsageContext): TurnUsage | undefined {
  const { model, reportedCost: reported, previousCost } = ctx;
  let usage: TurnUsage | undefined;
  if (res.usage) {
    usage = {
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cachedReadTokens: res.usage.cachedReadTokens ?? undefined,
      cachedWriteTokens: res.usage.cachedWriteTokens ?? undefined,
      thoughtTokens: res.usage.thoughtTokens ?? undefined,
      totalTokens: res.usage.totalTokens,
    };
  } else {
    const quota = (res._meta as { quota?: { token_count?: Record<string, number> } } | null)?.quota;
    const tokens = quota?.token_count;
    if (tokens && (tokens.input_tokens !== undefined || tokens.output_tokens !== undefined)) {
      usage = { inputTokens: tokens.input_tokens ?? 0, outputTokens: tokens.output_tokens ?? 0 };
    }
  }
  if (reported !== undefined) {
    return { ...(usage ?? { inputTokens: 0, outputTokens: 0 }), model, costUsd: reported };
  }
  if (!usage) {
    return previousCost === null
      ? undefined
      : { inputTokens: 0, outputTokens: 0, model, costUsd: previousCost };
  }
  // OpenAI-style input counts include the cached part; price it once.
  const cost = computeCost(model, {
    inputTokens: Math.max(0, usage.inputTokens - (usage.cachedReadTokens ?? 0)),
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.thoughtTokens,
    cacheReadTokens: usage.cachedReadTokens,
    cacheCreationTokens: usage.cachedWriteTokens,
  });
  return { ...usage, model, costUsd: (previousCost ?? 0) + cost };
}

/** File sharing note appended to a session's first prompt. */
export function sharedDirNote(sharedDir: string): string {
  return `[File sharing: to send a file to the user, write or copy it to ${sharedDir}/ and it will appear as a file card in this chat.]`;
}

/** Stop reasons that end a turn without an answer: the chat shows `failed`. */
export const FAILED_STOP_REASONS: ReadonlySet<string> = new Set([
  "refusal",
  "max_tokens",
  "max_turn_requests",
]);

export function fileUri(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}
