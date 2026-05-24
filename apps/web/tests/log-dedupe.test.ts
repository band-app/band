import { describe, expect, it } from "vitest";
import { LogThrottle } from "../src/lib/log-dedupe";

describe("LogThrottle", () => {
  it("permits the first occurrence of a key", () => {
    const throttle = new LogThrottle({ ttlMs: 1_000, now: () => 0 });
    expect(throttle.shouldLog("k")).toBe(true);
  });

  it("suppresses repeats within the TTL", () => {
    let t = 0;
    const throttle = new LogThrottle({ ttlMs: 1_000, now: () => t });

    expect(throttle.shouldLog("k")).toBe(true);
    t = 500;
    expect(throttle.shouldLog("k")).toBe(false);
    t = 999;
    expect(throttle.shouldLog("k")).toBe(false);
  });

  it("permits a repeat once the TTL has elapsed", () => {
    let t = 0;
    const throttle = new LogThrottle({ ttlMs: 1_000, now: () => t });

    expect(throttle.shouldLog("k")).toBe(true);
    t = 1_001;
    expect(throttle.shouldLog("k")).toBe(true);
    t = 1_500;
    expect(throttle.shouldLog("k")).toBe(false);
  });

  it("tracks distinct keys independently", () => {
    let t = 0;
    const throttle = new LogThrottle({ ttlMs: 1_000, now: () => t });

    expect(throttle.shouldLog("a")).toBe(true);
    expect(throttle.shouldLog("b")).toBe(true);
    t = 500;
    expect(throttle.shouldLog("a")).toBe(false);
    expect(throttle.shouldLog("b")).toBe(false);
  });

  it("evicts oldest entries when over maxEntries (FIFO)", () => {
    let t = 0;
    const throttle = new LogThrottle({ ttlMs: 1_000_000, maxEntries: 3, now: () => t });

    throttle.shouldLog("a");
    t = 1;
    throttle.shouldLog("b");
    t = 2;
    throttle.shouldLog("c");
    t = 3;
    throttle.shouldLog("d"); // evicts "a", map now holds b, c, d

    expect(throttle.size()).toBe(3);

    // "b", "c", "d" are still inside the TTL — suppressed.
    expect(throttle.shouldLog("b")).toBe(false);
    expect(throttle.shouldLog("c")).toBe(false);
    expect(throttle.shouldLog("d")).toBe(false);

    // "a" was evicted, so it counts as fresh and logs again. Adding it
    // back pushes the size to 4, which immediately evicts "b" (now the
    // oldest entry).
    expect(throttle.shouldLog("a")).toBe(true);
    expect(throttle.size()).toBe(3);

    // "b" was just evicted in the line above, so it logs again now.
    expect(throttle.shouldLog("b")).toBe(true);
  });

  it("issue #457 acceptance — 1-hour window, 30 s tick: 1 log line per host", () => {
    // The poller used to fire `console.error` once per host per CI tick
    // (every 30 s). With 60-minute throttle that's 120 calls -> at most
    // 1 log line per (host, error) pair per hour.
    let t = 0;
    const throttle = new LogThrottle({ ttlMs: 60 * 60 * 1000, now: () => t });
    const key = "gql:github.com:Field 'repository' doesn't exist on type 'Query'";

    let logged = 0;
    for (let tick = 0; tick < 120; tick++) {
      if (throttle.shouldLog(key)) {
        logged++;
      }
      t += 30_000;
    }

    // The first tick at t=0 logs, then every tick within the first hour is
    // suppressed. Each subsequent hour boundary releases one more line.
    // 120 ticks × 30 s = 3600 s = exactly the TTL — second log lands on the
    // tick whose time strictly exceeds the TTL.
    expect(logged).toBeLessThanOrEqual(2);
    expect(logged).toBeGreaterThanOrEqual(1);
  });

  it("reset clears all tracked keys", () => {
    const t = 0;
    const throttle = new LogThrottle({ ttlMs: 1_000, now: () => t });
    throttle.shouldLog("a");
    throttle.shouldLog("b");
    expect(throttle.size()).toBe(2);
    throttle.reset();
    expect(throttle.size()).toBe(0);
    // After reset both keys are fresh.
    expect(throttle.shouldLog("a")).toBe(true);
    expect(throttle.shouldLog("b")).toBe(true);
  });
});
