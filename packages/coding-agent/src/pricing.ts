/**
 * Per-model ratecard for the Reports dialog (issue #425).
 *
 * Providers fall into two camps:
 *
 *   • **Self-priced** — Claude Code and OpenCode include a USD figure
 *     directly in their per-turn session data (`result.total_cost_usd`,
 *     `step_finish.part.cost`). For those providers Band reads the
 *     reported number as-is; this ratecard is **not** consulted.
 *
 *   • **Token-only** — Codex (`token_count` events in
 *     `~/.codex/sessions/<date>/rollout-*.jsonl`) and Gemini CLI (OTLP
 *     `gen_ai.client.token.usage`) report token splits but no cost.
 *     `computeCost(model, tokens)` multiplies those by the rates below.
 *
 * **Maintenance.** Rates are in USD per 1M tokens. Hardcoded here rather
 * than pulled from a JSON file so the change shows up in code review when
 * a vendor adjusts pricing — same convention as Claude Code's SDK.
 * Unknown models return `0` and the UI renders `—` (see Reports dialog).
 *
 * Sources at time of writing: vendor public pricing pages (OpenAI
 * platform pricing, Google AI Studio pricing). Update with citations
 * in the commit message when you bump these.
 */

export interface ModelRates {
  /** USD per 1M input (uncached) tokens. */
  input: number;
  /** USD per 1M output tokens (includes reasoning tokens for o-series and
   *  Codex; Anthropic bills reasoning tokens as output for `result.usage`
   *  parity). */
  output: number;
  /**
   * USD per 1M tokens served from prompt cache. Optional — when unset we
   * fall back to `input / 10`, which is the most common discount across
   * providers (Anthropic, OpenAI) and a conservative under-estimate for
   * Gemini's cache hit rate. Per-model override always wins.
   */
  cacheRead?: number;
  /**
   * USD per 1M tokens written to the prompt cache. Anthropic-style "cache
   * creation" tokens that Claude bills at a small premium over the raw
   * input rate. Optional — when unset we fall back to `input * 1.25`.
   * Non-Claude providers don't track this; the field is dropped at
   * ingest time and the multiplier is unused.
   */
  cacheCreation?: number;
}

/**
 * Per-model rates keyed by the model identifier the provider reports.
 * Keep the key shape stable across provider naming drift (e.g. Codex's
 * `gpt-5` vs `gpt-5-2026-01-15` snapshots) — the lookup tries the exact
 * key first, then a longest-prefix match in `computeCost` so dated
 * snapshots fall back to the base model's rate.
 */
export const MODEL_PRICING: Record<string, ModelRates> = {
  // ── OpenAI / Codex ──
  // gpt-5 and o-series Codex rates from OpenAI platform pricing.
  "gpt-5": { input: 1.25, output: 10.0, cacheRead: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2.0, cacheRead: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005 },
  o3: { input: 2.0, output: 8.0, cacheRead: 0.5 },
  "o3-mini": { input: 1.1, output: 4.4, cacheRead: 0.55 },
  o4: { input: 3.0, output: 12.0, cacheRead: 0.75 },
  "codex-mini-latest": { input: 1.5, output: 6.0, cacheRead: 0.375 },

  // ── Google / Gemini ──
  "gemini-2.5-pro": { input: 1.25, output: 10.0, cacheRead: 0.31 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4, cacheRead: 0.025 },
  "gemini-2.0-flash-exp": { input: 0.1, output: 0.4, cacheRead: 0.025 },

  // ── Anthropic / Claude ──
  // Included for completeness even though Claude self-reports cost; if a
  // future Claude code path bypasses `total_cost_usd` (e.g. raw API
  // streaming), this acts as a safety net.
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  "claude-opus-4-7": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreation: 18.75 },
  "claude-haiku-4-5-20251001": {
    input: 0.8,
    output: 4.0,
    cacheRead: 0.08,
    cacheCreation: 1.0,
  },
};

export interface ComputeCostInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningOutputTokens?: number;
}

/**
 * Compute the USD cost for a set of token counts at the given model's
 * rate. Returns `0` for unknown models — the caller should treat that as
 * "cost unavailable" (the Reports UI already renders `—` in that case).
 *
 * Lookup tries:
 *   1. Exact match (`MODEL_PRICING[model]`)
 *   2. Longest-prefix match (e.g. `gpt-5-2026-01-15` → `gpt-5`)
 *
 * Reasoning tokens are billed at the model's output rate per OpenAI's
 * Responses-API billing (and Anthropic's parity convention).
 */
export function computeCost(model: string | undefined, tokens: ComputeCostInput): number {
  if (!model) return 0;
  const rates = resolveRates(model);
  if (!rates) return 0;

  const input = tokens.inputTokens ?? 0;
  const output = tokens.outputTokens ?? 0;
  const reasoning = tokens.reasoningOutputTokens ?? 0;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  const cacheCreation = tokens.cacheCreationTokens ?? 0;

  const cacheReadRate = rates.cacheRead ?? rates.input / 10;
  const cacheCreationRate = rates.cacheCreation ?? rates.input * 1.25;

  return (
    (input * rates.input +
      (output + reasoning) * rates.output +
      cacheRead * cacheReadRate +
      cacheCreation * cacheCreationRate) /
    1_000_000
  );
}

/**
 * Resolve a model id to its rates. Falls back to the longest prefix that
 * has an entry in `MODEL_PRICING` so dated vendor snapshots
 * (`gpt-5-2026-01-15`) inherit the base model's rate without per-snapshot
 * config churn. Returns `undefined` when nothing matches.
 */
function resolveRates(model: string): ModelRates | undefined {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;

  // Longest-prefix match — sorted by key length descending so
  // `gpt-5-mini` wins over `gpt-5` for a `gpt-5-mini-2026-01-15` id.
  let best: { key: string; rates: ModelRates } | undefined;
  for (const [key, rates] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, rates };
    }
  }
  return best?.rates;
}
