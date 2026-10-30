import type {
  PollResult,
  PollSubscription,
  PollUnit,
  SourceEvent,
  SubscriptionContext,
  SubscriptionSourceProvider,
} from "@band-app/plugin-api";
import type { BandServerApi } from "@band-app/plugin-api/server";
import { aggregateBranchHead, aggregateCommit, type CheckTrigger } from "./check-runs";
import { ciKey, obj } from "./json";
import { buildPrActivityQuery, initialCursor, parsePrActivity } from "./pr-activity";
import {
  HOOK_EVENTS,
  parseGithubDelivery,
  type ReviewTarget,
  reviewTargetOf,
  verifyGithubSignature,
} from "./webhook";

export const SOURCE_ID = "github";

/** Header names arrive lowercased, so a plain lookup finds them. */
const SIGNATURE = "x-hub-signature-256";
const EVENT = "x-github-event";
const DELIVERY = "x-github-delivery";

function toBuffer(bodyBase64: string): Buffer {
  return Buffer.from(bodyBase64, "base64");
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

function isCheckTrigger(value: unknown): value is CheckTrigger {
  const t = obj(value);
  return (
    !!t && typeof t.repo === "string" && typeof t.branch === "string" && typeof t.sha === "string"
  );
}

/**
 * GitHub as a source of subscription events. The signature check lives here because the scheme
 * (HMAC-SHA256 in `X-Hub-Signature-256`) belongs to GitHub. The core stores the secret and
 * decides what to do with the events, and tells open Checks panels itself only through the
 * `reviews.changed` call this provider makes for each verified delivery.
 */
export function createSubscriptionSource(api: BandServerApi): SubscriptionSourceProvider {
  /** The last CI event id seen per `repo@branch`, so a finished commit signals once. */
  const lastCiEvent = new Map<string, string>();

  function signal(target: ReviewTarget): void {
    const [owner, repo] = target.repo.split("/");
    if (!owner || !repo) return;
    api.reviews.changed({
      repo: { host: "github.com", owner, repo },
      ...(target.branch && { branch: target.branch }),
      ...(target.number && { number: target.number }),
    });
  }

  /** New comments and reviews on the repo's subscribed PRs, one query for all of them. */
  async function pollPullRequests(
    repo: string,
    unit: PollUnit,
    ctx: SubscriptionContext,
  ): Promise<PollResult[]> {
    const numberOf = (s: PollSubscription) => Number(s.key.slice(`github:pr:${repo}#`.length));
    const subs = unit.subscriptions;
    const numbers = [...new Set(subs.map(numberOf))].filter((n) => Number.isInteger(n) && n > 0);
    if (numbers.length === 0) return [];
    const output = await ctx.gh([
      "api",
      "graphql",
      "-f",
      `query=${buildPrActivityQuery(repo, numbers)}`,
    ]);
    const activity = parsePrActivity(repo, numbers, output);
    const results: PollResult[] = [];
    for (const sub of subs) {
      const items = activity.get(numberOf(sub));
      if (!items) continue;
      const cursor = sub.cursor ?? initialCursor(sub.createdAt);
      let newest = cursor;
      let fresh = false;
      const events: SourceEvent[] = [];
      for (const item of items) {
        // `>=` because GitHub stamps to the second; the event id dedupes the overlap.
        if (item.createdAt < cursor) continue;
        events.push(item.event);
        if (item.createdAt > newest) newest = item.createdAt;
        if (item.createdAt > cursor) fresh = true;
      }
      if (fresh) signal({ repo, number: numberOf(sub) });
      // Only this subscription: another one on the PR has its own cursor.
      results.push({ subscriptionId: sub.id, events, cursor: newest });
    }
    return results;
  }

  /** CI on a branch's head commit: an event once no check is pending. */
  async function pollBranch(
    repo: string,
    branch: string,
    ctx: SubscriptionContext,
  ): Promise<PollResult[]> {
    const event = await aggregateBranchHead(repo, branch, ctx);
    if (!event) return [];
    // The event id is the commit and verdict, so repeated polls of a finished commit deliver once.
    const seen = `${repo}@${branch}`;
    if (lastCiEvent.get(seen) !== event.id) {
      lastCiEvent.set(seen, event.id);
      signal({ repo, branch });
    }
    return [{ events: [event] }];
  }

  return {
    id: SOURCE_ID,

    async verifyDelivery({ secret, headers, bodyBase64 }) {
      if (!secret || !verifyGithubSignature(secret, toBuffer(bodyBase64), headers[SIGNATURE])) {
        return { ok: false };
      }
      return { ok: true, deliveryId: headers[DELIVERY]?.trim() || null };
    },

    async parseDelivery({ headers, bodyBase64 }) {
      const payload = parseJson(toBuffer(bodyBase64));
      if (payload === undefined) return { type: "ignored" };
      const eventType = headers[EVENT]?.trim() ?? "";
      // Only after the signature passed. Any change to a PR or its checks refreshes open
      // panels, whether or not a subscription listens.
      const target = reviewTargetOf(eventType, payload);
      if (target) signal(target);
      const parsed = parseGithubDelivery(eventType, headers[DELIVERY]?.trim() ?? "", payload);
      if (parsed.type !== "check") return parsed;
      const { repo, branch, sha } = parsed.trigger;
      return {
        type: "check",
        key: ciKey(repo, branch),
        flight: `${repo}@${sha}`,
        trigger: parsed.trigger,
      };
    },

    async aggregateChecks(trigger, ctx) {
      if (!isCheckTrigger(trigger)) throw new Error("Unexpected check trigger");
      return aggregateCommit(trigger, ctx);
    },

    async registerWebhook({ repo, url, secret }, ctx) {
      try {
        // The body goes over stdin: argv would show the secret in `ps`.
        await ctx.ghWithInput(
          ["api", `repos/${repo}/hooks`, "--input", "-"],
          JSON.stringify({
            name: "web",
            active: true,
            config: { url, content_type: "json", secret },
            events: [...HOOK_EVENTS],
          }),
        );
        return { status: "registered" };
      } catch (err) {
        // `execGh` rejects with gh's stderr, or with the execFile error (which repeats the
        // command line) when stderr is empty. Redact the secret before the text leaves.
        const raw = err instanceof Error ? err.message : "gh api failed";
        const full = secret ? raw.split(secret).join("***") : raw;
        if (/already exists/i.test(full)) return { status: "registered" };
        const message = full.split("\n")[0].trim() || "gh api failed";
        return { status: "failed", error: message.slice(0, 200) };
      }
    },

    async defaultSenders(repo, ctx) {
      const senders = [repo.split("/")[0]];
      try {
        const login = (JSON.parse(await ctx.gh(["api", "user"])) as { login?: unknown }).login;
        if (typeof login === "string" && login) senders.push(login);
      } catch (err) {
        api.log.warn("could not look up the authenticated gh user: %s", String(err));
      }
      return senders;
    },

    pollUnits(repo, subscriptions) {
      const units: PollUnit[] = [];
      const prefix = `github:pr:${repo}#`;
      const pullRequests = subscriptions.filter((s) => s.key.startsWith(prefix));
      if (pullRequests.length > 0) units.push({ id: `pr:${repo}`, subscriptions: pullRequests });
      const ciPrefix = `github:ci:${repo}@`;
      const branches = new Set<string>();
      for (const sub of subscriptions) {
        if (sub.key.startsWith(ciPrefix)) branches.add(sub.key.slice(ciPrefix.length));
      }
      for (const branch of [...branches].sort()) {
        units.push({
          id: `ci:${repo}@${branch}`,
          subscriptions: subscriptions.filter((s) => s.key === `${ciPrefix}${branch}`),
        });
      }
      return units;
    },

    async poll(repo, unit, ctx) {
      if (unit.id.startsWith("pr:")) return pollPullRequests(repo, unit, ctx);
      return pollBranch(repo, unit.id.slice(`ci:${repo}@`.length), ctx);
    },
  };
}
