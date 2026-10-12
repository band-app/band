import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HubStore, hubIdFor, type SecureKV } from "../src/lib/hub-store.ts";

/** An in-memory stand-in for the Keychain that records every key written. */
function memoryKV(): SecureKV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async getItemAsync(key) {
      return data.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      assert.match(key, /^[A-Za-z0-9._-]+$/, "secure store keys allow only [A-Za-z0-9._-]");
      data.set(key, value);
    },
    async deleteItemAsync(key) {
      data.delete(key);
    },
  };
}

const HUB = { url: "http://127.0.0.1:3456", label: "studio", token: "bdt_secret_one" };
const OTHER = { url: "https://hub.example.com", label: "server", token: "bdt_secret_two" };

describe("HubStore", () => {
  it("keeps a saved hub across a restart (a new store on the same Keychain)", async () => {
    const kv = memoryKV();
    const saved = await new HubStore(kv).save(HUB);
    const after = await new HubStore(kv).list();
    assert.deepEqual(after, { hubs: [saved], activeId: hubIdFor(HUB.url) });
  });

  it("replaces the hub with the same URL and makes the newest save active", async () => {
    const store = new HubStore(memoryKV());
    await store.save(HUB);
    await store.save(OTHER);
    await store.save({ ...HUB, token: "bdt_new" });
    const { hubs, activeId } = await store.list();
    assert.deepEqual(
      hubs.map((h) => [h.url, h.token]),
      [
        [HUB.url, "bdt_new"],
        [OTHER.url, OTHER.token],
      ],
    );
    assert.equal(activeId, hubIdFor(HUB.url));
  });

  it("switches and removes hubs, moving active to the next one", async () => {
    const kv = memoryKV();
    const store = new HubStore(kv);
    const a = await store.save(HUB);
    const b = await store.save(OTHER);
    await store.setActive(a.id);
    assert.equal((await store.list()).activeId, a.id);
    await store.remove(a.id);
    assert.deepEqual(await store.list(), { hubs: [b], activeId: b.id });
    await store.remove(b.id);
    assert.deepEqual(await store.list(), { hubs: [], activeId: null });
    assert.equal(
      [...kv.data.values()].some((v) => v.includes("bdt_")),
      false,
      "tokens are deleted",
    );
  });

  it("ignores an unreadable entry instead of failing", async () => {
    const kv = memoryKV();
    const store = new HubStore(kv);
    const a = await store.save(HUB);
    kv.data.set(`band.hub.${a.id}`, "not json");
    assert.deepEqual(await store.list(), { hubs: [], activeId: null });
  });
});

describe("S4: tokens live only in the secure store", () => {
  const appRoot = join(import.meta.dirname, "..");

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("the only storage the app uses is expo-secure-store", () => {
    const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const dep of [
      "@react-native-async-storage/async-storage",
      "expo-file-system",
      "react-native-mmkv",
    ]) {
      assert.equal(dep in pkg.dependencies, false, `${dep} must not be a dependency`);
    }
    for (const file of sources(join(appRoot, "src"))) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /from ["'][^"']*(async-storage|expo-file-system|mmkv)/, file);
      assert.doesNotMatch(text, /console\.(log|info|warn|error|debug)/, `${file} must not log`);
    }
    const storeUsers = sources(join(appRoot, "src")).filter((f) =>
      /from "expo-secure-store"/.test(readFileSync(f, "utf8")),
    );
    assert.deepEqual(
      storeUsers.map((f) => f.slice(appRoot.length + 1)),
      ["src/lib/secure-kv.ts"],
    );
  });

  it("writes the token through the secure store and nowhere else in the module", async () => {
    const kv = memoryKV();
    await new HubStore(kv).save(HUB);
    const holders = [...kv.data.entries()].filter(([, v]) => v.includes(HUB.token)).map(([k]) => k);
    assert.deepEqual(holders, [`band.hub.${hubIdFor(HUB.url)}`]);
  });
});
