import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AsyncKeyValueStore } from "@band-app/client/client-state";

import { createClientStateStorage } from "../src/lib/client-state-storage.ts";

function memoryBackend(): AsyncKeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getAllKeys: async () => [...data.keys()],
    multiGet: async (keys) => keys.map((k) => [k, data.get(k) ?? null] as const),
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

describe("createClientStateStorage", () => {
  it("keeps each hub's keys apart and writes through to the backend", async () => {
    const backend = memoryBackend();
    const one = createClientStateStorage(backend, "hub-1");
    one.setItem("band.mobile.collapsed-repos", '["alpha"]');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(
      [...backend.data.keys()],
      ["band-client-state:hub-1:band.mobile.collapsed-repos"],
    );

    const again = createClientStateStorage(backend, "hub-1");
    const other = createClientStateStorage(backend, "hub-2");
    await Promise.all([again.load(), other.load()]);
    assert.equal(again.getItem("band.mobile.collapsed-repos"), '["alpha"]');
    assert.equal(other.getItem("band.mobile.collapsed-repos"), null);
    assert.deepEqual(other.keys(), []);
  });

  it("removes a key from the backend", async () => {
    const backend = memoryBackend();
    const storage = createClientStateStorage(backend, "hub-1");
    storage.setItem("k", "v");
    storage.removeItem("k");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(backend.data.size, 0);
  });
});
