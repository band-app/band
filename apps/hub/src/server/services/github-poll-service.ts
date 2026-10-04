import { tmpdir } from "node:os";
import { createLogger } from "@band-app/logger";
import { execGh } from "../infra/git/git-client";
import {
  aggregateChecks,
  CHECK_RUNS_PER_PAGE,
  type CheckRun,
  githubCiKey,
  parseCheckRuns,
} from "../infra/subscriptions/github";
import {
  buildPrActivityQuery,
  initialCursor,
  parsePrActivity,
} from "../infra/subscriptions/github-poll";
import { githubWebhookService, publicHubUrl } from "./github-webhook-service";
import { pluginHost } from "./plugin-host-service";
import { type Subscription, subscriptionService } from "./subscription-service";

const log = createLogger("github-poll");

/**
 * `gh` calls one poll makes at most, one after another. Work beyond it waits
 * for the next poll, so many subscriptions never fire a burst of requests.
 */
const MAX_CALLS_PER_POLL = 6;
/** Pages of check runs read for one commit. */
const MAX_CHECK_PAGES = 5;
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
 * The polling fallback of the GitHub source (plan step S.5). Webhooks need a
 * public URL; without one the branch-status poller calls `poll()` on its CI
 * ticks, and this turns what it finds into the same events the webhook path
 * produces, so coalescing and delivery behave alike.
 *
 * It serves GitHub subscriptions of repos with no registered webhook. Once
 * any subscription of a repo is `registered`, the repo is no longer polled.
 */
export class GithubPollService {
  private readonly state: PollState = {
    polls: 0,
    offset: 0,
    failures: new Map(),
    running: false,
    callsLeft: 0,
  };

  /** One poll pass. Overlapping calls are dropped. */
  async poll(): Promise<void> {
    if (this.state.running || !pluginHost.isEnabled("github")) return;
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

  /** One `gh` call, counted against the poll's budget. */
  private gh(args: string[]): Promise<string> {
    this.state.callsLeft--;
    return execGh(args, tmpdir());
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
    const now = Date.now();
    const byRepo = new Map<string, Subscription[]>();
    for (const sub of subscriptionService.list()) {
      const repo = sub.config.repo;
      if (sub.source !== "github" || !repo || sub.expiresAt <= now) continue;
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), sub]);
    }
    const work: WorkItem[] = [];
    for (const [repo, subs] of [...byRepo].sort(([a], [b]) => a.localeCompare(b))) {
      let current = subs;
      // The hub got a public URL since the subscription waited for one.
      if (publicHubUrl() && current.some((s) => s.config.webhook?.status === "waiting-for-url")) {
        for (const sub of current.filter((s) => s.config.webhook?.status === "waiting-for-url")) {
          // One repo's failed registration must not end the poll for the rest.
          await githubWebhookService.ensureRegistered(sub).catch((err) => {
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
      work.push(...this.workFor(repo, waiting));
    }
    return work;
  }

  private workFor(repo: string, subs: Subscription[]): WorkItem[] {
    const work: WorkItem[] = [];
    const prSubs = subs.filter((s) => s.filterKey.startsWith(`github:pr:${repo}#`));
    if (prSubs.length > 0) {
      work.push({ id: `pr:${repo}`, repo, run: () => this.pollPullRequests(repo, prSubs) });
    }
    const branches = new Set<string>();
    for (const sub of subs) {
      const prefix = `github:ci:${repo}@`;
      if (sub.filterKey.startsWith(prefix)) branches.add(sub.filterKey.slice(prefix.length));
    }
    for (const branch of [...branches].sort()) {
      work.push({ id: `ci:${repo}@${branch}`, repo, run: () => this.pollBranch(repo, branch) });
    }
    return work;
  }

  /** New comments and reviews on the repo's subscribed PRs, one query for all of them. */
  private async pollPullRequests(repo: string, subs: Subscription[]): Promise<void> {
    const numberOf = (s: Subscription) => Number(s.filterKey.slice(`github:pr:${repo}#`.length));
    const numbers = [...new Set(subs.map(numberOf))].filter((n) => Number.isInteger(n) && n > 0);
    if (numbers.length === 0) return;
    const output = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${buildPrActivityQuery(repo, numbers)}`,
    ]);
    const activity = parsePrActivity(repo, numbers, output);
    for (const sub of subs) {
      const items = activity.get(numberOf(sub));
      if (!items) continue;
      const cursor = subscriptionService.getCursor(sub.id) ?? initialCursor(sub.createdAt);
      let newest = cursor;
      for (const item of items) {
        // `>=` because GitHub stamps to the second; the event id dedupes the overlap.
        if (item.createdAt < cursor) continue;
        try {
          // Only this subscription: another one on the PR has its own cursor.
          subscriptionService.ingest(item.event, sub.id);
        } catch (err) {
          log.warn(
            { repo, subscriptionId: sub.id, err: err instanceof Error ? err.message : String(err) },
            "skipping a malformed PR event",
          );
        }
        if (item.createdAt > newest) newest = item.createdAt;
      }
      if (newest !== cursor || subscriptionService.getCursor(sub.id) === undefined) {
        subscriptionService.setCursor(sub.id, newest);
      }
    }
  }

  /** CI on a branch's head commit: an event once no check is pending. */
  private async pollBranch(repo: string, branch: string): Promise<void> {
    if (!subscriptionService.hasSubscribers(githubCiKey(repo, branch))) return;
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    const checks: CheckRun[] = [];
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      // Out of budget mid-commit: a partial list could look complete, so wait for the next poll.
      if (page > 1 && this.state.callsLeft <= 0) return;
      const output = await this.gh([
        "api",
        `repos/${repo}/commits/${ref}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`,
      ]);
      const runs = parseCheckRuns(output);
      checks.push(...runs);
      if (runs.length < CHECK_RUNS_PER_PAGE) break;
    }
    const sha = checks.find((c) => c.headSha)?.headSha;
    if (!sha) return;
    const event = aggregateChecks(checks, { repo, branch, sha });
    // The event id is the commit and verdict, so repeated polls of a finished commit deliver once.
    if (event) subscriptionService.ingest(event);
  }
}

export const githubPollService = new GithubPollService();
