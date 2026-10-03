import { randomUUID } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { Cron, type CronOptions } from "croner";
import { z } from "zod";
import {
  type SubscriptionConfig,
  type SubscriptionCreator,
  SubscriptionQueries,
  type SubscriptionRecord,
} from "../infra/db/queries/subscriptions";
import { subscribe as subscribeStatusBus } from "../infra/events/status-event-bus";
import { type SubscriptionEvent, subscriptionEventSchema } from "../infra/subscriptions/event";
import { githubCiKey, githubPrKey } from "../infra/subscriptions/github";
import { buildSubscriptionMessage, SUMMARY_LIMIT } from "../infra/subscriptions/message";
import {
  hashWebhookToken,
  newWebhookToken,
  normalizeWebhook,
  webhookTokenMatches,
} from "../infra/subscriptions/webhook";
import { chatService } from "./chat-service";
import { submitOrQueueTask } from "./task-service";
import { emit } from "./watcher-service";

const log = createLogger("subscription-service");

const DAY_MS = 24 * 60 * 60 * 1000;
/** No subscription outlives this, whatever `expiresAt` asks for. */
export const MAX_SUBSCRIPTION_DAYS = 180;
const SWEEP_INTERVAL_MS = 60_000;
/** Tries to start a delivery this many times before giving the events up. */
const MAX_DELIVERY_ATTEMPTS = 3;
/** A burst this large is delivered at once instead of waiting out the window. */
const MAX_PENDING_EVENTS = 50;
/** How long a one-off timer's row survives its fire time, for the delivery and its retries. */
const ONE_OFF_GRACE_MS = 60 * 60 * 1000;

export type Subscription = SubscriptionRecord;

export const subscriptionCreateInput = z.object({
  chatId: z.string().min(1),
  workspaceId: z.string().min(1),
  source: z.string().min(1),
  kinds: z.array(z.string().min(1)).default([]),
  /** Defaults to the key of the source (`hook:<id>`, `timer:<id>`). */
  filterKey: z.string().min(1).optional(),
  coalesceSeconds: z.number().int().min(0).max(3600).default(30),
  maxWakeups: z.number().int().min(1).default(10),
  /** Epoch milliseconds. Defaults to, and is capped at, 180 days from now. */
  expiresAt: z.number().int().optional(),
  createdBy: z.enum(["agent", "coordinator", "user"]).default("agent"),
});

export type SubscriptionCreateInput = z.input<typeof subscriptionCreateInput>;

const sourceCommon = subscriptionCreateInput.omit({ source: true, kinds: true, filterKey: true });

export const webhookCreateInput = sourceCommon;
export type WebhookCreateInput = z.input<typeof webhookCreateInput>;

/** A timer fires once at `at` (epoch milliseconds) or on a `cron` schedule, not both. */
export const timerCreateInput = sourceCommon
  .extend({
    // Nothing to batch for a single tick, so fire at once by default.
    coalesceSeconds: z.number().int().min(0).max(3600).default(0),
    at: z.number().int().optional(),
    cron: z.string().min(1).optional(),
  })
  .refine((v) => (v.at === undefined) !== (v.cron === undefined), {
    message: "A timer needs exactly one of `at` and `cron`",
  });
export type TimerCreateInput = z.input<typeof timerCreateInput>;

export class InvalidTimerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTimerError";
  }
}

// Lowercased because GitHub reports `full_name` in its own casing and keys must match.
const repoSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, "repo must look like owner/name")
  .refine(
    (r) => r.split("/").every((s) => s !== "." && s !== ".."),
    "repo must look like owner/name",
  )
  .transform((r) => r.toLowerCase());

/** Activity on one pull request: comments, reviews, review comments and lifecycle. */
export const githubPrCreateInput = sourceCommon.extend({
  repo: repoSchema,
  number: z.number().int().min(1),
});
export type GithubPrCreateInput = z.input<typeof githubPrCreateInput>;

/** CI results on a branch, delivered once per commit when every check is done. */
export const githubCiCreateInput = sourceCommon.extend({
  repo: repoSchema,
  branch: z.string().min(1),
});
export type GithubCiCreateInput = z.input<typeof githubCiCreateInput>;

export type WebhookDeliveryResult = "accepted" | "unauthorized" | "not-found";

export class SubscriptionChatNotFoundError extends Error {
  constructor(chatId: string, workspaceId: string) {
    super(`Chat ${chatId} not found in workspace ${workspaceId}`);
    this.name = "SubscriptionChatNotFoundError";
  }
}

interface Pending {
  events: SubscriptionEvent[];
  timer: NodeJS.Timeout;
  /** Deliveries of this batch that failed so far. */
  attempts: number;
}

interface RuntimeState {
  /** Subscriptions by the event key they listen to; rebuilt on every change. */
  index: Map<string, Subscription[]>;
  /** Events waiting out their subscription's coalesce window. */
  pending: Map<string, Pending>;
  /** Armed timer subscriptions by id. */
  timers: Map<string, Cron>;
  stopBus?: () => void;
  sweeper?: NodeJS.Timeout;
  started: boolean;
}

// Held on globalThis so every bundle of this module shares one registry
// (same pattern as `task-service.ts` and `cronjob-service.ts`).
const STATE_KEY = Symbol.for("band.subscription-service");
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[STATE_KEY]) {
  g[STATE_KEY] = {
    index: new Map(),
    pending: new Map(),
    timers: new Map(),
    started: false,
  } satisfies RuntimeState;
}
const state = g[STATE_KEY] as RuntimeState;
// A state object from before timers existed (dev reload) lacks the map.
state.timers ??= new Map();

/**
 * Subscriptions (plan step S.1). A subscription points at a chat and a
 * key; `ingest` routes a normalised event to the matching subscriptions,
 * each holds events for its coalesce window, then sends one message
 * through `submitOrQueueTask`, which queues behind a running turn.
 *
 * Events waiting out a coalesce window live in memory only. A server
 * restart drops them; the subscriptions themselves are rebuilt from the
 * database in `start()`.
 */
export class SubscriptionService {
  constructor(private readonly queries: SubscriptionQueries = new SubscriptionQueries()) {}

  /** Loads the index from the database and starts listening for removed chats. */
  start(): void {
    if (state.started) return;
    state.started = true;
    this.rebuildIndex();
    for (const sub of this.queries.list()) this.armTimer(sub);
    state.stopBus = subscribeStatusBus((event) => {
      if (event.kind === "chat-removed" && event.chatId) {
        this.removeAll(this.queries.idsFor({ chatId: event.chatId }), "chat-removed");
      }
    });
    state.sweeper = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    state.sweeper.unref();
  }

  /** Clears timers. Subscriptions stay in the database. */
  stop(): void {
    state.started = false;
    state.stopBus?.();
    state.stopBus = undefined;
    if (state.sweeper) clearInterval(state.sweeper);
    state.sweeper = undefined;
    for (const pending of state.pending.values()) clearTimeout(pending.timer);
    state.pending.clear();
    for (const id of [...state.timers.keys()]) this.disarmTimer(id);
    state.index.clear();
  }

  create(input: SubscriptionCreateInput): Subscription {
    const parsed = subscriptionCreateInput.parse(input);
    const id = newSubscriptionId();
    return this.insert(id, parsed, {
      source: parsed.source,
      filterKey: parsed.filterKey ?? `${parsed.source}:${id}`,
      config: {},
    });
  }

  /**
   * A generic webhook: `POST /api/hooks/<id>` with the returned token in
   * `X-Band-Webhook-Token` becomes an event. Only the token's hash is
   * stored, so the token can't be read back later.
   */
  createWebhook(input: WebhookCreateInput): { subscription: Subscription; token: string } {
    const parsed = webhookCreateInput.parse(input);
    const id = newSubscriptionId();
    const token = newWebhookToken();
    const subscription = this.insert(
      id,
      { ...parsed, kinds: [] },
      {
        source: "webhook",
        filterKey: `hook:${id}`,
        config: { secretHash: hashWebhookToken(token) },
      },
    );
    return { subscription, token };
  }

  /**
   * A timer: fires at `at` once, or on `cron` (croner syntax, an optional
   * leading seconds field). A one-off removes itself after its message went out.
   */
  createTimer(input: TimerCreateInput): Subscription {
    const parsed = timerCreateInput.parse(input);
    const now = Date.now();
    const config: SubscriptionConfig = {};
    let expiresAt = parsed.expiresAt;
    let maxWakeups = parsed.maxWakeups;
    if (parsed.at !== undefined) {
      if (parsed.at <= now) throw new InvalidTimerError("`at` must be in the future");
      config.at = parsed.at;
      maxWakeups = 1;
      expiresAt ??= parsed.at + ONE_OFF_GRACE_MS;
    } else if (parsed.cron !== undefined) {
      assertValidCron(parsed.cron);
      config.cron = parsed.cron;
    }
    const id = newSubscriptionId();
    const subscription = this.insert(
      id,
      { ...parsed, kinds: [], maxWakeups, expiresAt },
      { source: "timer", filterKey: `timer:${id}`, config },
    );
    this.armTimer(subscription);
    return subscription;
  }

  /** Subscribes a chat to one PR. Webhook registration is the caller's job (`GithubWebhookService`). */
  createGithubPr(input: GithubPrCreateInput): Subscription {
    const parsed = githubPrCreateInput.parse(input);
    const { repo, number, ...common } = parsed;
    return this.insert(
      newSubscriptionId(),
      { ...common, kinds: [] },
      { source: "github", filterKey: githubPrKey(repo, number), config: { repo } },
    );
  }

  /** Subscribes a chat to CI on a branch. Push events stay out unless asked for. */
  createGithubCi(input: GithubCiCreateInput): Subscription {
    const parsed = githubCiCreateInput.parse(input);
    const { repo, branch, ...common } = parsed;
    return this.insert(
      newSubscriptionId(),
      { ...common, kinds: ["ci"] },
      { source: "github", filterKey: githubCiKey(repo, branch), config: { repo } },
    );
  }

  /** Whether a live subscription listens to this event key. */
  hasSubscribers(key: string): boolean {
    const now = Date.now();
    return (state.index.get(key) ?? []).some((s) => s.expiresAt > now);
  }

  /** GitHub subscriptions of a repository. */
  listGithub(repo: string): Subscription[] {
    return this.queries.list().filter((s) => s.source === "github" && s.config.repo === repo);
  }

  /** The polling cursor of a subscription (see `GithubPollService`). */
  getCursor(id: string): string | undefined {
    return this.queries.cursor(id);
  }

  setCursor(id: string, cursor: string): void {
    this.queries.setCursor(id, cursor, Date.now());
  }

  setConfig(id: string, config: SubscriptionConfig): void {
    this.queries.setConfig(id, config);
  }

  /**
   * Checks a webhook delivery's id and token. Returns `not-found` for an
   * unknown id (or a subscription that isn't a webhook), `unauthorized` for
   * a wrong token. Callers run it before reading the request body.
   */
  authorizeWebhook(subscriptionId: string, token: string): WebhookDeliveryResult {
    const sub = this.queries.find(subscriptionId);
    if (!sub || sub.source !== "webhook") return "not-found";
    if (!webhookTokenMatches(token, sub.config.secretHash)) return "unauthorized";
    return "accepted";
  }

  /** Turns an authorized webhook request into an event. */
  deliverWebhook(
    subscriptionId: string,
    headers: Record<string, string | string[] | undefined>,
    body: string,
  ): void {
    this.ingest(normalizeWebhook(subscriptionId, headers, body));
  }

  private insert(
    id: string,
    parsed: Omit<z.output<typeof subscriptionCreateInput>, "source" | "filterKey">,
    source: { source: string; filterKey: string; config: SubscriptionConfig },
  ): Subscription {
    const chat = chatService.get(parsed.chatId);
    if (!chat || chat.workspaceId !== parsed.workspaceId) {
      throw new SubscriptionChatNotFoundError(parsed.chatId, parsed.workspaceId);
    }
    const now = Date.now();
    const latest = now + MAX_SUBSCRIPTION_DAYS * DAY_MS;
    const record: Subscription = {
      id,
      chatId: parsed.chatId,
      workspaceId: parsed.workspaceId,
      source: source.source,
      kinds: parsed.kinds,
      filterKey: source.filterKey,
      coalesceSeconds: parsed.coalesceSeconds,
      maxWakeups: parsed.maxWakeups,
      wakeups: 0,
      expiresAt: Math.min(parsed.expiresAt ?? latest, latest),
      createdBy: parsed.createdBy as SubscriptionCreator,
      createdAt: now,
      config: source.config,
    };
    this.queries.insert(record);
    this.rebuildIndex();
    return record;
  }

  private armTimer(sub: Subscription): void {
    if (sub.source !== "timer" || state.timers.has(sub.id)) return;
    const fire = () => this.fireTimer(sub.id);
    try {
      let job: Cron;
      if (sub.config.at !== undefined) {
        // A one-off whose time passed while the server was down fires once now.
        job = new Cron(new Date(Math.max(sub.config.at, Date.now() + 10)), { unref: true }, fire);
      } else if (sub.config.cron) {
        job = new Cron(sub.config.cron, { unref: true }, fire);
      } else {
        return;
      }
      state.timers.set(sub.id, job);
    } catch (err) {
      log.error({ err, subscriptionId: sub.id }, "could not arm timer subscription");
    }
  }

  private disarmTimer(id: string): void {
    state.timers.get(id)?.stop();
    state.timers.delete(id);
  }

  private fireTimer(id: string): void {
    const sub = this.queries.find(id);
    if (!sub) {
      this.disarmTimer(id);
      return;
    }
    const at = Date.now();
    try {
      this.ingest({
        // One id per fire, so each tick is its own event even within a millisecond.
        id: `${at}-${randomUUID()}`,
        source: "timer",
        kind: "timer",
        key: `timer:${id}`,
        url: "",
        actor: "timer",
        summary: sub.config.cron ? `Timer fired (cron ${sub.config.cron})` : "Timer fired",
        at,
      });
    } catch (err) {
      log.error({ err, subscriptionId: id }, "timer fire failed");
    }
  }

  list(filter?: { chatId?: string; workspaceId?: string }): Subscription[] {
    return this.queries
      .list()
      .filter(
        (s) =>
          (!filter?.chatId || s.chatId === filter.chatId) &&
          (!filter?.workspaceId || s.workspaceId === filter.workspaceId),
      );
  }

  /** Events recorded for a subscription, with delivery times. */
  listEvents(subscriptionId: string) {
    return this.queries.events(subscriptionId);
  }

  remove(id: string): boolean {
    if (!this.queries.find(id)) return false;
    this.removeAll([id], "removed");
    return true;
  }

  /** Drops every subscription of a deleted workspace. */
  removeForWorkspace(workspaceId: string): void {
    this.removeAll(this.queries.idsFor({ workspaceId }), "workspace-removed");
  }

  /**
   * Routes one event: skips repeats of an event id, then holds the event
   * for each matching subscription until its coalesce window ends.
   */
  ingest(raw: SubscriptionEvent): void {
    const event = subscriptionEventSchema.parse(raw);
    const now = Date.now();
    const expired: string[] = [];
    for (const sub of state.index.get(event.key) ?? []) {
      if (sub.source !== event.source) continue;
      if (sub.kinds.length > 0 && !sub.kinds.includes(event.kind)) continue;
      if (sub.expiresAt <= now) {
        expired.push(sub.id);
        continue;
      }
      // The table's primary key is the event id; one event can match several
      // subscriptions, so the row is keyed by subscription and event together.
      const fresh = this.queries.insertEventIfAbsent({
        eventId: `${sub.id}:${event.id}`,
        subscriptionId: sub.id,
        receivedAt: now,
        deliveredAt: null,
        summary: event.summary.slice(0, SUMMARY_LIMIT),
      });
      if (!fresh) continue;
      this.hold(sub, event);
    }
    this.removeAll(expired, "expired");
  }

  private hold(sub: Subscription, event: SubscriptionEvent): void {
    const pending = state.pending.get(sub.id);
    if (pending) {
      pending.events.push(event);
      if (pending.events.length >= MAX_PENDING_EVENTS) {
        clearTimeout(pending.timer);
        this.flush(sub.id);
      }
      return;
    }
    const timer = setTimeout(() => this.flush(sub.id), sub.coalesceSeconds * 1000);
    timer.unref();
    state.pending.set(sub.id, { events: [event], timer, attempts: 0 });
  }

  private flush(id: string): void {
    const pending = state.pending.get(id);
    state.pending.delete(id);
    const sub = this.queries.find(id);
    if (!pending || !sub) return;
    if (sub.expiresAt <= Date.now()) {
      this.removeAll([id], "expired");
      return;
    }
    try {
      submitOrQueueTask({
        workspaceId: sub.workspaceId,
        chatId: sub.chatId,
        prompt: buildSubscriptionMessage(sub.filterKey, pending.events),
      });
    } catch (err) {
      this.retryOrDrop(sub, pending, err);
      return;
    }
    this.queries.markDelivered(
      pending.events.map((e) => `${id}:${e.id}`),
      Date.now(),
    );
    const wakeups = sub.wakeups + 1;
    this.queries.setWakeups(id, wakeups);
    emit({
      kind: "subscription-delivered",
      subscriptionId: id,
      chatId: sub.chatId,
      workspaceId: sub.workspaceId,
      eventCount: pending.events.length,
    });
    if (wakeups >= sub.maxWakeups) {
      this.removeAll([id], "max-wakeups");
    }
  }

  /**
   * A failed delivery (for example the workspace can't be resolved) keeps
   * its events and tries again after a coalesce window, up to
   * MAX_DELIVERY_ATTEMPTS. After that the events' rows are deleted, so the
   * source can send them again, instead of staying marked as seen forever.
   */
  private retryOrDrop(sub: Subscription, pending: Pending, err: unknown): void {
    const attempts = pending.attempts + 1;
    const rowIds = pending.events.map((e) => `${sub.id}:${e.id}`);
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      log.warn(
        { err, subscriptionId: sub.id, chatId: sub.chatId, events: rowIds.length },
        "giving up delivering subscription events",
      );
      this.queries.removeEvents(rowIds);
      return;
    }
    log.warn(
      { err, subscriptionId: sub.id, chatId: sub.chatId, attempts },
      "could not deliver subscription, will retry",
    );
    const timer = setTimeout(() => this.flush(sub.id), Math.max(sub.coalesceSeconds, 1) * 1000);
    timer.unref();
    state.pending.set(sub.id, { events: pending.events, timer, attempts });
  }

  private sweepExpired(): void {
    const now = Date.now();
    this.removeAll(
      this.queries
        .list()
        .filter((s) => s.expiresAt <= now)
        .map((s) => s.id),
      "expired",
    );
  }

  private removeAll(
    ids: string[],
    reason: NonNullable<Parameters<typeof emit>[0]["reason"]>,
  ): void {
    if (ids.length === 0) return;
    for (const id of ids) {
      const sub = this.queries.find(id);
      const pending = state.pending.get(id);
      if (pending) clearTimeout(pending.timer);
      state.pending.delete(id);
      this.disarmTimer(id);
      this.queries.remove(id);
      if (sub) {
        emit({
          kind: "subscription-removed",
          subscriptionId: id,
          chatId: sub.chatId,
          workspaceId: sub.workspaceId,
          reason,
        });
      }
    }
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    const index = new Map<string, Subscription[]>();
    for (const sub of this.queries.list()) {
      const list = index.get(sub.filterKey);
      if (list) list.push(sub);
      else index.set(sub.filterKey, [sub]);
    }
    state.index = index;
  }
}

function newSubscriptionId(): string {
  return `sub_${randomUUID()}`;
}

function assertValidCron(expression: string): void {
  try {
    const options: CronOptions = { maxRuns: 0 };
    void new Cron(expression, options);
  } catch {
    throw new InvalidTimerError("Invalid cron expression");
  }
}

/** Process-wide singleton used by routers and other services. */
export const subscriptionService = new SubscriptionService();
