import type { AccountUsage, AccountUsageProvider } from "@band-app/host-api";

import { readClaudeUsage } from "./claude-usage";
import { readCodexUsage } from "./codex-usage";

const OK_TTL_MS = 3 * 60_000;
/** A missing login is cheap to re-check, so it is not held long. */
const NOT_LOGGED_IN_TTL_MS = 30_000;
const ERROR_TTL_MS = 60_000;
/** The usage endpoint asked us to slow down, so leave it alone for a while. */
const RATE_LIMITED_TTL_MS = 5 * 60_000;

function ttlOf(result: AccountUsage): number {
  switch (result.status) {
    case "ok":
      return OK_TTL_MS;
    case "not-logged-in":
      return NOT_LOGGED_IN_TTL_MS;
    case "rate-limited":
      return RATE_LIMITED_TTL_MS;
    default:
      return ERROR_TTL_MS;
  }
}

interface Entry {
  result: AccountUsage;
  expiresAt: number;
}

const readers: Record<AccountUsageProvider, () => Promise<AccountUsage>> = {
  claude: readClaudeUsage,
  codex: readCodexUsage,
};

const cache = new Map<AccountUsageProvider, Entry>();
const inFlight = new Map<AccountUsageProvider, Promise<AccountUsage>>();

function read(provider: AccountUsageProvider, refresh: boolean): Promise<AccountUsage> {
  const cached = cache.get(provider);
  // A refresh skips the cache, except for a rate-limited answer: asking again right away only extends the limit.
  const keep = cached && (!refresh || cached.result.status === "rate-limited");
  if (cached && keep && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
  const pending = inFlight.get(provider);
  if (pending) return pending;
  const next = readers[provider]()
    .catch((): AccountUsage => ({
      provider,
      status: "error",
      account: null,
      plan: null,
      windows: [],
      updatedAt: Date.now(),
    }))
    .then((result) => {
      cache.set(provider, { result, expiresAt: Date.now() + ttlOf(result) });
      return result;
    })
    .finally(() => inFlight.delete(provider));
  inFlight.set(provider, next);
  return next;
}

/** Usage of the Claude and Codex accounts logged in on this machine. Never rejects. */
export function readAccountUsage(options?: { refresh?: boolean }): Promise<AccountUsage[]> {
  const refresh = options?.refresh === true;
  return Promise.all([read("claude", refresh), read("codex", refresh)]);
}
