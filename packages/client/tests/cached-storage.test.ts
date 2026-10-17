import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type AsyncKeyValueStore, createCachedStorage } from "../src/client-state.ts";

describe("createCachedStorage", () => {
  it("loads the backend once, serves reads from memory and writes through", async () => {
    const data = new Map([["a", "1"]]);
    const backend: AsyncKeyValueStore = {
      getAllKeys: async () => [...data.keys()],
      multiGet: async (keys) => keys.map((k) => [k, data.get(k) ?? null] as const),
      setItem: async (k, v) => void data.set(k, v),
      removeItem: async (k) => void data.delete(k),
    };
    const storage = createCachedStorage(backend);
    assert.equal(storage.getItem("a"), null);
    await storage.load();
    assert.equal(storage.getItem("a"), "1");

    storage.setItem("b", "2");
    assert.equal(storage.getItem("b"), "2");
    assert.deepEqual(storage.keys().sort(), ["a", "b"]);
    storage.removeItem("a");
    assert.equal(storage.getItem("a"), null);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([...data.entries()], [["b", "2"]]);
  });
});
