/**
 * Pure-function tests for the session-scoped TLS exception store
 * (`apps/desktop/src/browser/cert-exceptions.ts`, issue #444). No
 * Electron deps, so the test runs under `node:test` like the other
 * desktop unit-shaped suites.
 *
 * The invariants enforced here back the acceptance criteria on the
 * GitHub issue:
 *
 *   - Same (partition, host, fingerprint) ⇒ accepted on every check.
 *   - Different host ⇒ NOT accepted (per-host exceptions).
 *   - Different fingerprint ⇒ NOT accepted (rotated cert re-prompts).
 *   - Different partition ⇒ NOT accepted (exceptions don't leak
 *     across sessions / partitions).
 *   - Case-insensitive host match (matches Chrome).
 *   - `clear()` drops everything (used in tests to reset).
 *
 * The real-network integration test in
 * `cert-error-integration.test.ts` exercises the same store against
 * a fingerprint extracted from a real self-signed cert over a real
 * TLS handshake.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  CertExceptionStore,
  exceptionKey,
  partitionForSession,
} from "../src/browser/cert-exceptions.ts";

describe("CertExceptionStore", () => {
  test("has() returns false on a fresh store", () => {
    const store = new CertExceptionStore();
    assert.equal(
      store.has({ partition: "default", host: "example.com", fingerprint: "sha256/abc" }),
      false,
    );
    assert.equal(store.size(), 0);
  });

  test("add() then has() matches the same triple", () => {
    const store = new CertExceptionStore();
    store.add({ partition: "default", host: "example.com", fingerprint: "sha256/abc" });
    assert.equal(
      store.has({ partition: "default", host: "example.com", fingerprint: "sha256/abc" }),
      true,
    );
    assert.equal(store.size(), 1);
  });

  test("different fingerprint on same host is NOT accepted (rotated cert)", () => {
    const store = new CertExceptionStore();
    store.add({ partition: "default", host: "example.com", fingerprint: "sha256/abc" });
    assert.equal(
      store.has({ partition: "default", host: "example.com", fingerprint: "sha256/xyz" }),
      false,
    );
  });

  test("different host is NOT accepted (per-host exceptions only)", () => {
    const store = new CertExceptionStore();
    store.add({ partition: "default", host: "example.com", fingerprint: "sha256/abc" });
    assert.equal(
      store.has({ partition: "default", host: "other.com", fingerprint: "sha256/abc" }),
      false,
    );
  });

  test("different partition is NOT accepted (no cross-partition leak)", () => {
    const store = new CertExceptionStore();
    store.add({ partition: "default", host: "example.com", fingerprint: "sha256/abc" });
    assert.equal(
      store.has({ partition: "private", host: "example.com", fingerprint: "sha256/abc" }),
      false,
    );
  });

  test("host comparison is case-insensitive (matches Chrome)", () => {
    const store = new CertExceptionStore();
    store.add({ partition: "default", host: "EXAMPLE.com", fingerprint: "sha256/abc" });
    assert.equal(
      store.has({ partition: "default", host: "example.COM", fingerprint: "sha256/abc" }),
      true,
    );
  });

  test("add() is idempotent — re-adding doesn't grow the set", () => {
    const store = new CertExceptionStore();
    store.add({ partition: "default", host: "example.com", fingerprint: "sha256/abc" });
    store.add({ partition: "default", host: "example.com", fingerprint: "sha256/abc" });
    store.add({ partition: "default", host: "EXAMPLE.com", fingerprint: "sha256/abc" });
    assert.equal(store.size(), 1);
  });

  test("clear() drops every exception", () => {
    const store = new CertExceptionStore();
    store.add({ partition: "default", host: "example.com", fingerprint: "sha256/abc" });
    store.add({ partition: "default", host: "other.com", fingerprint: "sha256/def" });
    assert.equal(store.size(), 2);
    store.clear();
    assert.equal(store.size(), 0);
    assert.equal(
      store.has({ partition: "default", host: "example.com", fingerprint: "sha256/abc" }),
      false,
    );
  });
});

describe("exceptionKey", () => {
  test("identical triples produce identical keys", () => {
    const a = exceptionKey({
      partition: "default",
      host: "example.com",
      fingerprint: "sha256/abc",
    });
    const b = exceptionKey({
      partition: "default",
      host: "example.com",
      fingerprint: "sha256/abc",
    });
    assert.equal(a, b);
  });

  test("host case is normalised", () => {
    const lower = exceptionKey({
      partition: "default",
      host: "example.com",
      fingerprint: "sha256/abc",
    });
    const upper = exceptionKey({
      partition: "default",
      host: "EXAMPLE.COM",
      fingerprint: "sha256/abc",
    });
    assert.equal(lower, upper);
  });

  test("fingerprint case is NOT normalised (hex case is part of identity)", () => {
    const a = exceptionKey({
      partition: "default",
      host: "example.com",
      fingerprint: "sha256/abc",
    });
    const b = exceptionKey({
      partition: "default",
      host: "example.com",
      fingerprint: "sha256/ABC",
    });
    assert.notEqual(a, b);
  });
});

describe("partitionForSession", () => {
  test("undefined / null session ⇒ 'default'", () => {
    assert.equal(partitionForSession(undefined), "default");
    assert.equal(partitionForSession(null), "default");
  });

  test("in-memory partition (null storagePath) ⇒ 'in-memory'", () => {
    assert.equal(partitionForSession({ storagePath: null }), "in-memory");
  });

  test("session with storagePath ⇒ the path verbatim", () => {
    const path = "/users/me/Library/Application Support/Band";
    assert.equal(partitionForSession({ storagePath: path }), path);
  });

  test("named partition ⇒ its own storagePath", () => {
    const named = "/users/me/Library/Application Support/Band/Partitions/work";
    assert.equal(partitionForSession({ storagePath: named }), named);
  });
});
