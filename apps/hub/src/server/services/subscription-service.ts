import { randomUUID } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { z } from "zod";
import {
  type SubscriptionCreator,
  SubscriptionQueries,
  type SubscriptionRecord,
} from "../infra/db/queries/subscriptions";
import { subscribe as subscribeStatusBus } from "../infra/events/status-event-bus";
import { type SubscriptionEvent, subscriptionEventSchema } from "../infra/subscriptions/event";
import { buildSubscriptionMessage } from "../infra/subscriptions/message";
import { chatService } from "./chat-service";
import { submitOrQueueTask } from "./task-service";
import { emit } from "./watcher-service";

const log = createLogger("subscription-service");

const DAY_MS = 24 * 60 * 60 * 1000;
/** No subscription outlives this, whatever `expiresAt` asks for. */
export const MAX_SUBSCRIPTION_DAYS = 180;
const SWEEP_INTERVAL_MS = 60_000;

export type Subscription = SubscriptionRecord;

export const subscriptionCreateInput = z.object({
  chatId: z.string().min(1),
  workspaceId: z.string().min(1),
  source: z.string().min(1),
  kinds: z.array(z.string().min(1)).default([]),
  filterKey: z.string().min(1),
  coalesceSeconds: z.number().int().min(0).max(3600).default(30),
  maxWakeups: z.number().int().min(1).default(10),
  /** Epoch milliseconds. Defaults to, and is capped at, 180 days from now. */
  expiresAt: z.number().int().optional(),
  createdBy: z.enum(["agent", "coordinator", "user"]).default("agent"),
});

export type SubscriptionCreateInput = z.input<typeof subscriptionCreateInput>;

export class SubscriptionChatNotFoundError extends Error {
  constructor(chatId: string, workspaceId: string) {
    super(`Chat ${chatId} not found in workspace ${workspaceId}`);
    this.name = "SubscriptionChatNotFoundError";
  }
}

interface Pending {
  events: SubscriptionEvent[];
  timer: NodeJS.Timeout;
}

interface RuntimeState {
  /** Subscriptions by the event key they listen to; rebuilt on every change. */
  index: Map<string, Subscription[]>;
  /** Events waiting out their subscription's coalesce window. */
  pending: Map<string, Pending>;
  stopBus?: () => void;
  sweeper?: NodeJS.Timeout;
  started: boolean;
}

// Held on globalThis so every bundle of this module shares one registry
// (same pattern as `task-service.ts` and `cronjob-service.ts`).
const STATE_KEY = Symbol.for("band.subscription-service");
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[STATE_KEY]) {
  g[STATE_KEY] = { index: new Map(), pending: new Map(), started: false } satisfies RuntimeState;
}
const state = g[STATE_KEY] as RuntimeState;

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
    state.index.clear();
  }

  create(input: SubscriptionCreateInput): Subscription {
    const parsed = subscriptionCreateInput.parse(input);
    const chat = chatService.get(parsed.chatId);
    if (!chat || chat.workspaceId !== parsed.workspaceId) {
      throw new SubscriptionChatNotFoundError(parsed.chatId, parsed.workspaceId);
    }
    const now = Date.now();
    const latest = now + MAX_SUBSCRIPTION_DAYS * DAY_MS;
    const record: Subscription = {
      id: `sub_${randomUUID()}`,
      chatId: parsed.chatId,
      workspaceId: parsed.workspaceId,
      source: parsed.source,
      kinds: parsed.kinds,
      filterKey: parsed.filterKey,
      coalesceSeconds: parsed.coalesceSeconds,
      maxWakeups: parsed.maxWakeups,
      wakeups: 0,
      expiresAt: Math.min(parsed.expiresAt ?? latest, latest),
      createdBy: parsed.createdBy as SubscriptionCreator,
      createdAt: now,
    };
    this.queries.insert(record);
    this.rebuildIndex();
    return record;
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
  events(subscriptionId: string) {
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
    for (const sub of state.index.get(event.key) ?? []) {
      if (sub.source !== event.source) continue;
      if (sub.kinds.length > 0 && !sub.kinds.includes(event.kind)) continue;
      if (sub.expiresAt <= now) {
        this.removeAll([sub.id], "expired");
        continue;
      }
      // The table's primary key is the event id; one event can match several
      // subscriptions, so the row is keyed by subscription and event together.
      const fresh = this.queries.insertEventIfAbsent({
        eventId: `${sub.id}:${event.id}`,
        subscriptionId: sub.id,
        receivedAt: now,
        deliveredAt: null,
        summary: event.summary.slice(0, 500),
      });
      if (!fresh) continue;
      this.hold(sub, event);
    }
  }

  private hold(sub: Subscription, event: SubscriptionEvent): void {
    const pending = state.pending.get(sub.id);
    if (pending) {
      pending.events.push(event);
      return;
    }
    const timer = setTimeout(() => this.flush(sub.id), sub.coalesceSeconds * 1000);
    timer.unref();
    state.pending.set(sub.id, { events: [event], timer });
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
      log.warn({ err, subscriptionId: id, chatId: sub.chatId }, "could not deliver subscription");
      return;
    }
    this.queries.markDelivered(
      pending.events.map((e) => `${id}:${e.id}`),
      Date.now(),
    );
    const wakeups = sub.wakeups + 1;
    this.queries.incrementWakeups(id, wakeups);
    emit({
      kind: "subscription-delivered",
      subscriptionId: id,
      chatId: sub.chatId,
      workspaceId: sub.workspaceId,
      eventCount: pending.events.length,
    });
    if (wakeups >= sub.maxWakeups) {
      this.removeAll([id], "max-wakeups");
      return;
    }
    this.rebuildIndex();
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

/** Process-wide singleton used by routers and other services. */
export const subscriptionService = new SubscriptionService();
