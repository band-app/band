import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AsyncKeyValueStore } from "@band-app/client/client-state";
import { matchKey } from "@band-app/shared/client-state-keys";
import { createClientStateStorage } from "../src/lib/client-state-storage.ts";
import {
  effectiveGroupFilter,
  GROUP_FILTER_KEY,
  parseGroupFilter,
} from "../src/lib/group-filter.ts";

function memoryBackend(): AsyncKeyValueStore {
  const data = new Map<string, string>();
  return {
    getAllKeys: async () => [...data.keys()],
    multiGet: async (keys) => keys.map((k) => [k, data.get(k) ?? null] as const),
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

describe("group filter", () => {
  it("is the phone's own key, not the web's shared one", () => {
    assert.equal(GROUP_FILTER_KEY, "band.mobile.group-filter");
    assert.notEqual(GROUP_FILTER_KEY, "band.repos-list.group-filter");
    assert.ok(matchKey(GROUP_FILTER_KEY), "the hub accepts the key");
  });

  it("survives an app restart and leaves the web's key alone", async () => {
    const backend = memoryBackend();
    const first = createClientStateStorage(backend, "hub-1");
    first.setItem(GROUP_FILTER_KEY, "grp_1");
    await new Promise((r) => setTimeout(r, 0));

    const restarted = createClientStateStorage(backend, "hub-1");
    await restarted.load();
    assert.equal(parseGroupFilter(restarted.getItem(GROUP_FILTER_KEY)), "grp_1");
    assert.equal(restarted.getItem("band.repos-list.group-filter"), null);

    restarted.removeItem(GROUP_FILTER_KEY);
    assert.equal(parseGroupFilter(restarted.getItem(GROUP_FILTER_KEY)), null);
  });

  it("treats an empty or deleted group as All", () => {
    assert.equal(parseGroupFilter(""), null);
    assert.equal(parseGroupFilter(null), null);
    assert.equal(effectiveGroupFilter("gone", [{ id: "a" }]), null);
    assert.equal(effectiveGroupFilter("a", [{ id: "a" }]), "a");
  });
});
