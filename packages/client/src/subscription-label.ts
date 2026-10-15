/**
 * How a chat's subscription reads in the "Listening" list, on the web and on the phone.
 */

export interface SubscriptionLike {
  id: string;
  source: string;
  filterKey: string;
  cron?: string;
  at?: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "github:pr:o/r#3" becomes "PR o/r#3"; other sources name themselves. */
export function describeWatch(sub: SubscriptionLike): { source: string; watches: string } {
  const [kind, ...rest] = sub.filterKey.split(":");
  const target = rest.join(":");
  if (sub.source === "github" && kind === "github") {
    const [type, ...path] = target.split(":");
    const name = path.join(":");
    if (type === "pr") return { source: "GitHub", watches: `PR ${name}` };
    if (type === "ci") return { source: "GitHub", watches: `CI on ${name}` };
  }
  if (sub.source === "timer") {
    if (sub.cron) return { source: "Timer", watches: `cron ${sub.cron}` };
    if (sub.at !== undefined) {
      return { source: "Timer", watches: `once at ${new Date(sub.at).toLocaleString()}` };
    }
    return { source: "Timer", watches: "timer" };
  }
  if (sub.source === "webhook") {
    return { source: "Webhook", watches: `/api/hooks/${sub.id}` };
  }
  return { source: sub.source, watches: sub.filterKey };
}

/** How long until `expiresAt`, in the largest whole unit. */
export function formatExpiry(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "expired";
  if (left >= DAY_MS) return `expires in ${Math.floor(left / DAY_MS)}d`;
  if (left >= HOUR_MS) return `expires in ${Math.floor(left / HOUR_MS)}h`;
  return `expires in ${Math.max(1, Math.floor(left / MINUTE_MS))}m`;
}
