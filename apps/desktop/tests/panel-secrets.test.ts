/**
 * Integration test for the panel secret store: real files under a sandboxed HOME and the
 * AES-GCM test key store that stands in for the Keychain.
 */

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { createPanelSecrets } from "../src/main/services/panel-secrets.ts";
import { createTestSecretStore, setSecretStore } from "../src/main/services/secret-store.ts";

function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesContaining(path, needle));
    else if (readFileSync(path).includes(needle)) found.push(path);
  }
  return found;
}

describe("panel secrets", () => {
  let home: string;
  const originalHome = process.env.HOME;
  let prompts: string[];
  const secrets = () =>
    createPanelSecrets(async (reason) => {
      prompts.push(reason);
    });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "band-desktop-panel-secrets-"));
    process.env.HOME = home;
    prompts = [];
    setSecretStore(createTestSecretStore());
  });

  afterEach(async () => {
    setSecretStore(null);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  test("a value comes back after set, also from a fresh instance, and is never in clear text", async () => {
    secrets().set("desktop", "mac:w1:me", "s3cret-pw");
    assert.equal(await secrets().get("desktop", "mac:w1:me"), "s3cret-pw");
    assert.deepEqual(filesContaining(home, "s3cret-pw"), []);
  });

  test("reads ask for confirmation, a missing key does not", async () => {
    const store = secrets();
    store.set("desktop", "k", "v");
    assert.equal(await store.get("desktop", "nope"), null);
    assert.deepEqual(prompts, []);
    await store.get("desktop", "k");
    assert.equal(prompts.length, 1);
  });

  test("a refused confirmation rejects the read", async () => {
    secrets().set("desktop", "k", "v");
    const refusing = createPanelSecrets(async () => {
      throw new Error("canceled");
    });
    await assert.rejects(() => refusing.get("desktop", "k"), /canceled/);
  });

  test("one extension cannot read another's key", async () => {
    const store = secrets();
    store.set("ext-a", "mac:w1:me", "a-secret");
    assert.equal(await store.get("ext-b", "mac:w1:me"), null);
    await assert.rejects(() => store.get("__proto__", "mac:w1:me"), /Invalid extension id/);
  });

  test("delete removes the value", async () => {
    const store = secrets();
    store.set("desktop", "k", "v");
    store.delete("desktop", "k");
    assert.equal(await store.get("desktop", "k"), null);
  });

  test("rejects oversized and malformed input", () => {
    const store = secrets();
    assert.throws(() => store.set("desktop", "k".repeat(201), "v"), /Invalid secret key/);
    assert.throws(() => store.set("desktop", "k", "v".repeat(4097)), /Invalid secret value/);
    assert.throws(() => store.set("desktop", "k", 5), /Invalid secret value/);
    assert.throws(() => store.set("", "k", "v"), /Invalid extension id/);
  });

  test("without an OS key store nothing is available and set fails", () => {
    setSecretStore({ available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" });
    const store = secrets();
    assert.equal(store.available(), false);
    assert.throws(() => store.set("desktop", "k", "v"), /key store/);
  });
});
