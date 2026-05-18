/**
 * Pure-function tests for the cert-error metadata helpers
 * (`apps/desktop/src/browser/cert-error.ts`, issue #444). No Electron
 * deps — `CertificateLike` is a structural subset so the helpers can
 * be exercised without Electron's runtime types.
 *
 * Coverage:
 *
 *   - `hostFromUrl` extracts the lowercased hostname and gracefully
 *     handles unparseable inputs.
 *   - `describeCertError` returns Chrome-style explanations for the
 *     common error codes and falls back to a generic string for
 *     unknown codes.
 *   - `buildCertErrorPayload` plumbs every input field into the
 *     correct snake_case slot on the renderer payload.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  buildCertErrorPayload,
  describeCertError,
  hostFromUrl,
} from "../src/browser/cert-error.ts";

describe("hostFromUrl", () => {
  test("extracts the hostname from an https URL", () => {
    assert.equal(hostFromUrl("https://example.com/some/path"), "example.com");
  });

  test("lowercases the hostname", () => {
    assert.equal(hostFromUrl("https://EXAMPLE.com/"), "example.com");
  });

  test("returns the bare host for URLs without a path", () => {
    assert.equal(hostFromUrl("https://example.com"), "example.com");
  });

  test("strips the port from the host", () => {
    assert.equal(hostFromUrl("https://example.com:8443/foo"), "example.com");
  });

  test("returns '' for unparseable inputs", () => {
    assert.equal(hostFromUrl("not a url"), "");
    assert.equal(hostFromUrl(""), "");
  });
});

describe("describeCertError", () => {
  test("returns a specific message for CERT_DATE_INVALID", () => {
    assert.match(describeCertError("net::ERR_CERT_DATE_INVALID"), /expired|not yet valid/i);
  });

  test("returns a specific message for CERT_AUTHORITY_INVALID (self-signed)", () => {
    assert.match(describeCertError("CERT_AUTHORITY_INVALID"), /self-signed|unrecognised/i);
  });

  test("returns a specific message for CERT_COMMON_NAME_INVALID", () => {
    assert.match(describeCertError("net::ERR_CERT_COMMON_NAME_INVALID"), /hostname/i);
  });

  test("returns a specific message for CERT_REVOKED", () => {
    assert.match(describeCertError("CERT_REVOKED"), /revoked/i);
  });

  test("falls back to a generic message for unknown codes", () => {
    const msg = describeCertError("net::ERR_UNKNOWN_CERT_PROBLEM");
    assert.match(msg, /could not be verified/);
    assert.match(msg, /net::ERR_UNKNOWN_CERT_PROBLEM/);
  });
});

describe("buildCertErrorPayload", () => {
  test("plumbs every field into the snake_case payload", () => {
    const payload = buildCertErrorPayload({
      key: "tab-42",
      url: "https://EXAMPLE.com:8443/login",
      errorCode: "net::ERR_CERT_DATE_INVALID",
      certificate: {
        fingerprint: "sha256/abc123",
        subjectName: "CN=example.com",
        issuerName: "CN=example.com",
        validStart: 1_700_000_000,
        validExpiry: 1_800_000_000,
      },
    });
    assert.equal(payload.browser_id, "tab-42");
    assert.equal(payload.workspace_id, "tab-42");
    assert.equal(payload.url, "https://EXAMPLE.com:8443/login");
    assert.equal(payload.host, "example.com");
    assert.equal(payload.error_code, "net::ERR_CERT_DATE_INVALID");
    assert.match(payload.error_description, /expired|not yet valid/i);
    assert.equal(payload.fingerprint, "sha256/abc123");
    assert.equal(payload.subject_name, "CN=example.com");
    assert.equal(payload.issuer_name, "CN=example.com");
    assert.equal(payload.valid_start, 1_700_000_000);
    assert.equal(payload.valid_expiry, 1_800_000_000);
  });

  test("missing certificate fields are passed through as undefined", () => {
    const payload = buildCertErrorPayload({
      key: "tab-1",
      url: "https://example.com/",
      errorCode: "CERT_AUTHORITY_INVALID",
      certificate: { fingerprint: "sha256/zzz" },
    });
    assert.equal(payload.subject_name, undefined);
    assert.equal(payload.issuer_name, undefined);
    assert.equal(payload.valid_start, undefined);
    assert.equal(payload.valid_expiry, undefined);
    assert.equal(payload.fingerprint, "sha256/zzz");
  });

  test("unparseable URL still produces a payload with an empty host", () => {
    const payload = buildCertErrorPayload({
      key: "tab-1",
      url: "garbage",
      errorCode: "CERT_INVALID",
      certificate: { fingerprint: "sha256/abc" },
    });
    assert.equal(payload.host, "");
    assert.equal(payload.url, "garbage");
  });
});
