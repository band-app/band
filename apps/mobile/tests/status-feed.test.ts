import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StatusFeed, type StatusSource, type StatusSubscriber } from "../src/lib/status-feed.ts";
import type { StatusEvent } from "../src/lib/status-state.ts";

/** A source whose subscriptions the test drives by hand. */
function scriptedSource() {
  const live: StatusSubscriber[] = [];
  let unsubscribed = 0;
  const source: StatusSource = {
    subscribe(subscriber) {
      live.push(subscriber);
      return {
        unsubscribe() {
          unsubscribed++;
        },
      };
    },
  };
  return {
    source,
    get subscriptions() {
      return live.length;
    },
    get unsubscribed() {
      return unsubscribed;
    },
    latest: () => live[live.length - 1] as StatusSubscriber,
  };
}

const snapshot = (...ids: string[]): StatusEvent => ({
  kind: "snapshot",
  statuses: ids.map((worktreeId) => ({ worktreeId, agent: { status: "working" } })),
});

describe("StatusFeed", () => {
  it("is live once the subscription starts and holds the state the events build", () => {
    const script = scriptedSource();
    const feed = new StatusFeed(script.source);
    feed.start();
    assert.equal(feed.getSnapshot().connection, "connecting");
    script.latest().onStarted();
    script.latest().onData(snapshot("a-main"));
    assert.equal(feed.getSnapshot().connection, "live");
    assert.equal(feed.getSnapshot().state.agents.size, 1);
  });

  it("subscribes again after a drop and keeps the last state while reconnecting", async () => {
    const script = scriptedSource();
    const feed = new StatusFeed(script.source, 5);
    feed.start();
    script.latest().onData(snapshot("a-main"));
    script.latest().onError();
    assert.equal(feed.getSnapshot().connection, "reconnecting");
    assert.equal(feed.getSnapshot().state.agents.size, 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(script.subscriptions, 2);
    script.latest().onData(snapshot("b-main"));
    assert.equal(feed.getSnapshot().connection, "live");
    assert.deepEqual([...feed.getSnapshot().state.agents.keys()], ["b-main"]);
    feed.stop();
  });

  it("retargets to a new source and ignores the old subscription afterwards", () => {
    const first = scriptedSource();
    const second = scriptedSource();
    const feed = new StatusFeed(first.source);
    feed.start();
    const old = first.latest();
    old.onData(snapshot("a-main"));
    feed.retarget(second.source);
    assert.equal(first.unsubscribed, 1);
    assert.equal(feed.getSnapshot().connection, "reconnecting");
    assert.equal(feed.getSnapshot().state.agents.size, 1);
    old.onData(snapshot("stale"));
    old.onError();
    assert.deepEqual([...feed.getSnapshot().state.agents.keys()], ["a-main"]);
    second.latest().onData(snapshot("c-main"));
    assert.deepEqual([...feed.getSnapshot().state.agents.keys()], ["c-main"]);
    assert.equal(feed.getSnapshot().connection, "live");
    feed.stop();
  });

  it("passes raw events to handlers and stops notifying after stop()", () => {
    const script = scriptedSource();
    const feed = new StatusFeed(script.source);
    const seen: string[] = [];
    feed.onEvent((e) => seen.push(e.kind));
    let notified = 0;
    feed.subscribe(() => notified++);
    feed.start();
    script.latest().onData(snapshot("a-main"));
    assert.deepEqual(seen, ["snapshot"]);
    feed.stop();
    const before = notified;
    script.latest().onData(snapshot("b-main"));
    assert.equal(notified, before);
  });
});
