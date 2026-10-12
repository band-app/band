/**
 * Keeps one `status.stream` subscription alive and exposes what it carries: the status state,
 * whether the stream is live, and the raw events. A dropped subscription is opened again after
 * `retryMs`, and `retarget` swaps the source (a new client after the app returns to the
 * foreground) while the last state stays on screen until the new snapshot replaces it.
 */

import {
  applyStatusEvent,
  emptyStatusState,
  type StatusEvent,
  type StatusState,
} from "./status-state.ts";

export interface StatusSubscriber {
  onStarted(): void;
  onData(event: StatusEvent): void;
  onError(): void;
  onComplete(): void;
}

export interface StatusSource {
  subscribe(subscriber: StatusSubscriber): { unsubscribe(): void };
}

/** `connecting` before the first answer, `live` while events flow, `reconnecting` after a drop. */
export type FeedConnection = "connecting" | "live" | "reconnecting";

export interface FeedSnapshot {
  state: StatusState;
  connection: FeedConnection;
}

export class StatusFeed {
  private source: StatusSource;
  private readonly retryMs: number;
  private snapshot: FeedSnapshot = { state: emptyStatusState(), connection: "connecting" };
  private started = false;
  private generation = 0;
  private subscription: { unsubscribe(): void } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly eventHandlers = new Set<(event: StatusEvent) => void>();

  constructor(source: StatusSource, retryMs = 2000) {
    this.source = source;
    this.retryMs = retryMs;
  }

  /** The current value. The object changes only when the state or the connection does. */
  getSnapshot = (): FeedSnapshot => this.snapshot;

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Raw events, for code that reads the stream itself (the client-state sync). */
  onEvent(handler: (event: StatusEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.open();
  }

  stop(): void {
    this.started = false;
    this.close();
  }

  /** Subscribes through `source` instead. The state shown so far stays until the new snapshot. */
  retarget(source: StatusSource): void {
    this.source = source;
    if (!this.started) return;
    this.close();
    this.setConnection("reconnecting");
    this.open();
  }

  private open(): void {
    const generation = ++this.generation;
    const current = () => this.started && generation === this.generation;
    this.subscription = this.source.subscribe({
      onStarted: () => {
        if (current()) this.setConnection("live");
      },
      onData: (event) => {
        if (!current()) return;
        this.setConnection("live");
        const state = applyStatusEvent(this.snapshot.state, event);
        if (state !== this.snapshot.state) this.update({ ...this.snapshot, state });
        for (const handler of this.eventHandlers) handler(event);
      },
      onError: () => {
        if (current()) this.lost();
      },
      onComplete: () => {
        if (current()) this.lost();
      },
    });
  }

  private close(): void {
    this.generation++;
    this.subscription?.unsubscribe();
    this.subscription = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private lost(): void {
    this.subscription = null;
    this.setConnection("reconnecting");
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.started) this.open();
    }, this.retryMs);
  }

  private setConnection(connection: FeedConnection): void {
    if (this.snapshot.connection === connection) return;
    this.update({ ...this.snapshot, connection });
  }

  private update(next: FeedSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
