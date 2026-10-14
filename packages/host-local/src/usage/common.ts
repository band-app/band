import type {
  AccountUsage,
  AccountUsageFailure,
  AccountUsageProvider,
  UsageWindow,
} from "@band-app/host-api";

const REQUEST_TIMEOUT_MS = 10_000;

/** The usage endpoint answered with an error status. */
export class UsageHttpError extends Error {
  constructor(readonly status: number) {
    super(`usage endpoint answered ${status}`);
  }

  get failure(): AccountUsageFailure {
    if (this.status === 401 || this.status === 403) return "expired";
    if (this.status === 429) return "rate-limited";
    return "error";
  }
}

export async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new UsageHttpError(response.status);
  }
  return (await response.json()) as T;
}

export function percentOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null;
}

/** Reset times arrive as ISO strings, epoch seconds or epoch milliseconds. */
export function resetOf(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "" && !Number.isFinite(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  // 1e10 separates any epoch in seconds from any epoch in milliseconds.
  return n > 10_000_000_000 ? n : n * 1000;
}

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function ok(
  provider: AccountUsageProvider,
  account: string | null,
  plan: string | null,
  windows: UsageWindow[],
): AccountUsage {
  return { provider, status: "ok", account, plan, windows, updatedAt: Date.now() };
}

export function failure(
  provider: AccountUsageProvider,
  status: AccountUsageFailure,
  account: string | null,
): AccountUsage {
  return { provider, status, account, plan: null, windows: [], updatedAt: Date.now() };
}
