import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ClientStateApi, ClientStateStore } from "../src/client-state.ts";

// An older hub answers BAND-style BAD_REQUEST for a key it does not know. The store keeps the
// value locally, pushes it once, and stays quiet.
describe("a hub that does not know a client-state key", () => {
  it("pushes the key once, keeps the value and does not warn", async () => {
    const data = new Map<string, string>();
    let calls = 0;
    const refusal = Object.assign(new Error("Not a client-state key: band-appearance"), {
      data: { code: "BAD_REQUEST", httpStatus: 400 },
    });
    const api = {
      clientState: {
        set: {
          mutate: async () => {
            calls++;
            throw refusal;
          },
        },
        delete: { mutate: async () => ({}) },
        list: { query: async () => ({ entries: [] }) },
      },
    } as unknown as ClientStateApi;
    const store = new ClientStateStore({
      storage: {
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => void data.set(k, v),
        removeItem: (k) => void data.delete(k),
        keys: () => [...data.keys()],
      },
      getApi: async () => api,
      deviceType: () => "desktop",
    });
    await store.hydrate(null);
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      store.setItem("band-appearance", '{"a":1}');
      await new Promise((r) => setTimeout(r, 700));
      store.setItem("band-appearance", '{"a":2}');
      await new Promise((r) => setTimeout(r, 700));
    } finally {
      console.warn = warn;
    }
    assert.equal(store.getItem("band-appearance"), '{"a":2}');
    assert.equal(calls, 1);
    assert.equal(warnings.length, 0);
  });
});
