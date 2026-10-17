import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AsyncKeyValueStore } from "@band-app/client/client-state";
import { matchKey } from "@band-app/shared/client-state-keys";

import { createClientStateStorage } from "../src/lib/client-state-storage.ts";
import {
  effectiveLabelFilter,
  LABEL_FILTER_KEY,
  parseLabelFilter,
} from "../src/lib/label-filter.ts";

function memoryBackend(): AsyncKeyValueStore {
  const data = new Map<string, string>();
  return {
    getAllKeys: async () => [...data.keys()],
    multiGet: async (keys) => keys.map((k) => [k, data.get(k) ?? null] as const),
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

describe("label filter", () => {
  it("is the phone's own key, not the web's shared one", () => {
    assert.equal(LABEL_FILTER_KEY, "band.mobile.label-filter");
    assert.notEqual(LABEL_FILTER_KEY, "band.repos-list.label-filter");
    assert.ok(matchKey(LABEL_FILTER_KEY), "the hub accepts the key");
  });

  it("survives an app restart and leaves the web's key alone", async () => {
    const backend = memoryBackend();
    const first = createClientStateStorage(backend, "hub-1");
    first.setItem(LABEL_FILTER_KEY, "lbl_1");
    await new Promise((r) => setTimeout(r, 0));

    const restarted = createClientStateStorage(backend, "hub-1");
    await restarted.load();
    assert.equal(parseLabelFilter(restarted.getItem(LABEL_FILTER_KEY)), "lbl_1");
    assert.equal(restarted.getItem("band.repos-list.label-filter"), null);

    restarted.removeItem(LABEL_FILTER_KEY);
    assert.equal(parseLabelFilter(restarted.getItem(LABEL_FILTER_KEY)), null);
  });

  it("treats an empty or deleted label as All", () => {
    assert.equal(parseLabelFilter(""), null);
    assert.equal(parseLabelFilter(null), null);
    assert.equal(effectiveLabelFilter("gone", [{ id: "a" }]), null);
    assert.equal(effectiveLabelFilter("a", [{ id: "a" }]), "a");
  });
});
