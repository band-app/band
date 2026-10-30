import { createLogger } from "@band-app/logger";
import type { PollResult, PollSubscription } from "@band-app/plugin-api";
import { pluginHost } from "./plugin-host-service";
import { type Subscription, subscriptionService } from "./subscription-service";
import {
  publicHubUrl,
  subscriptionContext,
  subscriptionSourceService,
} from "./subscription-source-service";

const log = createLogger("subscription-poll");

/** The one source with a polling fallback; its plugin id is the subscription `source`. */
const SOURCE = "github";

/**
 * `gh` calls one poll makes at most, one after another. Work beyond it waits
 * for the next poll, so many subscriptions never fire a burst of requests.
 */
const MAX_CALLS_PER_POLL = 6;
/** A failing source is skipped for 2^failures polls, up to this many. */
const MAX_BACKOFF_POLLS = 16;

interface WorkItem {
  /** Identifies the work across polls, for backoff and round-robin. */
  id: string;
  repo: string;
  run: () => Promise<void>;
}

interface PollState {
  polls: number;
  /** Round-robin position into the sorted work list. */
  offset: number;
  failures: Map<string, { count: number; retryAtPoll: number; message: string }>;
  running: boolean;
  /** `gh` calls this poll may still make. */
  callsLeft: number;
}

/**
 * The polling fallback of a subscription source (plan step S.5). Webhooks need a
 * public URL; without one the branch-status poller calls `poll()` on its CI
 * ticks, and this turns what the source's provider finds into the same events the
 * webhook path produces, so coalescing and delivery behave alike.
 *
 * It serves subscriptions of repos with no registered webhook. Once
 * any subscription of a repo is `registered`, the repo is no longer polled. The
 * budget, round robin and backoff are the core's; reading the forge is the provider's.
 */
export class SubscriptionPollService {
  private readonly state: PollState = {
    polls: 0,
    offset: 0,
    failures: new Map(),
    running: false,
    callsLeft: 0,
  };

  /** One poll pass. Overlapping calls are dropped. */
  async poll(): Promise<void> {
    if (this.state.running || !pluginHost.isEnabled(SOURCE)) return;
    this.state.running = true;
    try {
      await this.pollOnce();
    } finally {
      this.state.running = false;
    }
  }

  private async pollOnce(): Promise<void> {
    const poll = ++this.state.polls;
    const work = await this.collect();
    const live = new Set(work.map((w) => w.id));
    for (const id of [...this.state.failures.keys()]) {
      if (!live.has(id)) this.state.failures.delete(id);
    }
    const due = work.filter((w) => (this.state.failures.get(w.id)?.retryAtPoll ?? 0) <= poll);
    if (due.length === 0) return;
    const start = this.state.offset % due.length;
    const batch = [...due.slice(start), ...due.slice(0, start)].slice(0, MAX_CALLS_PER_POLL);
    this.state.callsLeft = MAX_CALLS_PER_POLL;
    let ran = 0;
    for (const item of batch) {
      if (this.state.callsLeft <= 0) break;
      ran++;
      try {
        await item.run();
        this.state.failures.delete(item.id);
      } catch (err) {
        this.fail(item, poll, err);
      }
    }
    this.state.offset = start + ran;
  }

  /** The provider's `gh`, with each call counted against the poll's budget. */
  private context() {
    const base = subscriptionContext(() => this.state.callsLeft);
    return {
      ...base,
      gh: (args: string[]) => {
        this.state.callsLeft--;
        return base.gh(args);
      },
    };
  }

  /** Logs a failure once per distinct message, and skips the item for longer each time it repeats. */
  private fail(item: WorkItem, poll: number, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const previous = this.state.failures.get(item.id);
    const count = (previous?.count ?? 0) + 1;
    this.state.failures.set(item.id, {
      count,
      message,
      retryAtPoll: poll + Math.min(2 ** count, MAX_BACKOFF_POLLS),
    });
    if (previous?.message !== message) {
      log.warn({ repo: item.repo, work: item.id, err: message.split("\n")[0] }, "poll failed");
    }
  }

  /** The polling work for every repo that has no webhook. */
  private async collect(): Promise<WorkItem[]> {
    const provider = await pluginHost.subscriptionSourceFor(SOURCE);
    if (!provider) return [];
    const now = Date.now();
    const byRepo = new Map<string, Subscription[]>();
    for (const sub of subscriptionService.list()) {
      const repo = sub.config.repo;
      if (sub.source !== SOURCE || !repo || sub.expiresAt <= now) continue;
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), sub]);
    }
    const work: WorkItem[] = [];
    for (const [repo, subs] of [...byRepo].sort(([a], [b]) => a.localeCompare(b))) {
      let current = subs;
      // The hub got a public URL since the subscription waited for one.
      if (publicHubUrl() && current.some((s) => s.config.webhook?.status === "waiting-for-url")) {
        for (const sub of current.filter((s) => s.config.webhook?.status === "waiting-for-url")) {
          // One repo's failed registration must not end the poll for the rest.
          await subscriptionSourceService.ensureRegistered(sub).catch((err) => {
            log.warn(
              { repo, err: err instanceof Error ? err.message : String(err) },
              "could not register webhook",
            );
          });
        }
        current = subscriptionService.listGithub(repo);
      }
      if (current.some((s) => s.config.webhook?.status === "registered")) continue;
      // A failed registration leaves no webhook either, so those poll too.
      const waiting = current.filter(
        (s) =>
          s.config.webhook?.status === "waiting-for-url" || s.config.webhook?.status === "failed",
      );
      const polled: PollSubscription[] = waiting.map((s) => ({
        id: s.id,
        key: s.filterKey,
        createdAt: s.createdAt,
        cursor: null,
      }));
      for (const unit of provider.pollUnits(repo, polled)) {
        work.push({
          id: unit.id,
          repo,
          run: async () => {
            // Cursors are read here, for the units this tick polls, not for every subscription.
            const subscriptions = unit.subscriptions.map((s) => ({
              ...s,
              cursor: subscriptionService.getCursor(s.id) ?? null,
            }));
            const results = await provider.poll(repo, { ...unit, subscriptions }, this.context());
            for (const result of results) this.apply(repo, result);
          },
        });
      }
    }
    return work;
  }

  /** Ingests a poll result for one subscription (or everyone on the key) and stores its cursor. */
  private apply(repo: string, result: PollResult): void {
    const { subscriptionId, events, cursor } = result;
    for (const event of events) {
      if (subscriptionId === undefined) {
        subscriptionService.ingest({ ...event, source: SOURCE });
        continue;
      }
      try {
        subscriptionService.ingest({ ...event, source: SOURCE }, subscriptionId);
      } catch (err) {
        log.warn(
          { repo, subscriptionId, err: err instanceof Error ? err.message : String(err) },
          "skipping a malformed event",
        );
      }
    }
    if (
      subscriptionId !== undefined &&
      cursor !== undefined &&
      cursor !== subscriptionService.getCursor(subscriptionId)
    ) {
      subscriptionService.setCursor(subscriptionId, cursor);
    }
  }
}

export const subscriptionPollService = new SubscriptionPollService();
