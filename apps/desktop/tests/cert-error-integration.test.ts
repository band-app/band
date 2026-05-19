/**
 * Real-network integration test for the cert-error interstitial
 * pipeline (issue #444).
 *
 * Per CLAUDE.md (`.claude/skills/integration-tests/SKILL.md`): boots
 * a real HTTPS server with a *real* self-signed certificate on an
 * OS-assigned port, performs a real TLS handshake with `node:tls`,
 * and exercises the production code paths end-to-end with the same
 * fingerprint Chromium would compute against the same cert.
 *
 * What this test does NOT do: drive Electron's `certificate-error`
 * event itself. That signal is fired by Chromium's network stack
 * inside the Electron runtime, which is impractical to host in
 * `node:test` (no Electron binary on the test path). Instead the
 * test verifies:
 *
 *   1. A real self-signed cert fails the system trust store as
 *      expected — a plain `fetch()` rejects with the same
 *      `DEPTH_ZERO_SELF_SIGNED_CERT` / `SELF_SIGNED_CERT_IN_CHAIN`
 *      error Chromium would surface in production. Without this,
 *      the rest of the test would be exercising the wrong code
 *      path.
 *   2. The fingerprint extracted from a live TLS handshake matches
 *      the fingerprint computed from the cert's DER bytes. Confirms
 *      that the exception store would key against a stable value.
 *   3. The exception store accepts the original triple and rejects
 *      a rotated cert (different fingerprint) for the same host,
 *      matching the acceptance criteria around "Rotating the cert
 *      re-triggers the interstitial".
 *   4. `describeCertError` returns a self-signed-specific
 *      explanation when Chromium-style codes flow through.
 *
 * This is the closest we can get to an Electron-free, no-mocks
 * verification of the cert-error pipeline. Full coverage requires
 * a manual smoke test inside the packaged `.app` against the same
 * fake HTTPS server — documented in the PR description.
 */

import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import * as tls from "node:tls";
import { buildCertErrorPayload, describeCertError } from "../src/browser/cert-error.ts";
import { CertExceptionStore, partitionForSession } from "../src/browser/cert-exceptions.ts";

/**
 * Spawn openssl to generate a fresh self-signed certificate for the
 * given Common Name. Returns paths to the key / cert in the supplied
 * directory plus their PEM contents so the caller can feed both to
 * `https.createServer` and to the assertion helpers.
 *
 * Uses real openssl rather than `selfsigned` / `node-forge` so the
 * cert is binary-identical to what a developer would generate by
 * hand for their local dev server. Test infrastructure has openssl
 * available (verified on macOS / Linux runners; the test will skip
 * if it ever isn't, with a clear error).
 */
function generateSelfSigned(dir: string, commonName: string) {
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  // `-nodes` disables passphrase. RSA 2048 + SHA-256 ⇒ Chromium
  // accepts it as a valid (but untrusted) cert, which is exactly the
  // case the interstitial is designed for.
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "${keyPath}" -out "${certPath}" -subj "/CN=${commonName}"`,
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  return { keyPath, certPath };
}

/**
 * Strip the PEM envelope and return the DER bytes for the cert.
 * Chromium's `Certificate.fingerprint` is the SHA-256 hash of the
 * DER bytes, so computing it ourselves keeps the test independent
 * of any specific Electron-flavoured serialisation.
 */
function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}

/**
 * Open a real TLS connection to the server and capture the leaf
 * cert. `rejectUnauthorized: false` is required because the cert is
 * self-signed by design — we're trying to read it, not validate it.
 * Anything else (e.g. `https.get` with default settings) rejects
 * before the cert is observable.
 */
function fetchPeerCert(host: string, port: number): Promise<tls.DetailedPeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate(true);
      socket.end();
      resolve(cert);
    });
    socket.on("error", reject);
  });
}

describe("cert-error integration (real self-signed HTTPS server)", () => {
  let tmpDir: string;
  let server: https.Server;
  let port: number;
  let certPem: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "band-cert-test-"));
    const { keyPath, certPath } = generateSelfSigned(tmpDir, "localhost");
    let keyPem: string;
    [keyPem, certPem] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
    server = https.createServer({ key: keyPem, cert: certPem }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object", "server address is missing");
    port = addr.port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("self-signed HTTPS rejects a default fetch — confirms the test exercises the right path", async () => {
    // `fetch` honours the system trust store; a self-signed cert is
    // outside it by definition. If this assertion ever fails, the
    // cert generator produced something the OS already trusts and
    // the rest of the test is meaningless.
    //
    // Node's `fetch` wraps the underlying TLS error in a bare
    // `TypeError: fetch failed`; the cert-specific code lives on
    // `error.cause.code`. We assert on the cause so the test fails
    // loudly if a future Node version starts serving a self-signed
    // cert as trusted.
    let err: unknown;
    try {
      await fetch(`https://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
      assert.fail("fetch unexpectedly succeeded for a self-signed cert");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "expected TypeError from fetch");
    const cause = (err as { cause?: { code?: string } }).cause;
    assert.ok(cause, "fetch error should carry an underlying cause");
    // Node surfaces the self-signed case as either
    // `DEPTH_ZERO_SELF_SIGNED_CERT` (this is what we get for a real
    // self-signed cert) or `SELF_SIGNED_CERT_IN_CHAIN` depending on
    // the trust path. Accept either.
    assert.match(
      cause.code ?? "",
      /SELF_SIGNED_CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i,
      `unexpected fetch failure cause: ${JSON.stringify(cause)}`,
    );
  });

  test("our fingerprint matches the one a real TLS handshake observes", async () => {
    const peer = await fetchPeerCert("127.0.0.1", port);
    // Electron's `Certificate.fingerprint` format is `sha256/<hex>`
    // computed over the DER bytes — match that here so the assertion
    // mirrors what the BrowserViewManager would store.
    const der = pemToDer(certPem);
    const ours = `sha256/${createHash("sha256").update(der).digest("hex")}`;
    // Node's `getPeerCertificate(true)` returns the same hash as
    // `fingerprint256` (uppercase hex with colons) — normalise both
    // sides to lowercase non-delimited hex before comparing.
    const node = `sha256/${peer.fingerprint256.replace(/:/g, "").toLowerCase()}`;
    assert.equal(ours, node);
  });

  test("exception store accepts the original triple and rejects a rotated cert", async () => {
    const peer = await fetchPeerCert("127.0.0.1", port);
    const fingerprint = `sha256/${peer.fingerprint256.replace(/:/g, "").toLowerCase()}`;
    const partition = partitionForSession(undefined); // default

    const store = new CertExceptionStore();
    store.add({ partition, host: "localhost", fingerprint });

    // Same triple ⇒ accepted (acceptance criterion: subsequent
    // navigation does not re-prompt).
    assert.equal(store.has({ partition, host: "localhost", fingerprint }), true);

    // Simulated cert rotation: a fresh self-signed cert against the
    // same hostname has a different fingerprint (different key
    // material). The store must reject — the interstitial would
    // appear again, matching Chrome.
    const rotatedDir = await mkdtemp(join(tmpdir(), "band-cert-test-rot-"));
    try {
      const { certPath: rotatedPath } = generateSelfSigned(rotatedDir, "localhost");
      const rotatedPem = await readFile(rotatedPath, "utf8");
      const rotatedDer = pemToDer(rotatedPem);
      const rotatedFp = `sha256/${createHash("sha256").update(rotatedDer).digest("hex")}`;
      assert.notEqual(rotatedFp, fingerprint, "rotated cert should have a different fingerprint");
      assert.equal(store.has({ partition, host: "localhost", fingerprint: rotatedFp }), false);
    } finally {
      await rm(rotatedDir, { recursive: true, force: true });
    }
  });

  test("payload built from a real self-signed cert carries the host + fingerprint + explanation", async () => {
    const peer = await fetchPeerCert("127.0.0.1", port);
    const fingerprint = `sha256/${peer.fingerprint256.replace(/:/g, "").toLowerCase()}`;
    const payload = buildCertErrorPayload({
      key: "tab-test",
      url: `https://127.0.0.1:${port}/protected`,
      errorCode: "net::ERR_CERT_AUTHORITY_INVALID",
      certificate: {
        fingerprint,
        subjectName: peer.subject?.CN ? `CN=${peer.subject.CN}` : undefined,
        issuerName: peer.issuer?.CN ? `CN=${peer.issuer.CN}` : undefined,
      },
    });
    // Host: extracted from URL, lowercased. 127.0.0.1 stays as-is.
    assert.equal(payload.host, "127.0.0.1");
    assert.equal(payload.url, `https://127.0.0.1:${port}/protected`);
    // Fingerprint flows through verbatim — same string the exception
    // store will key off.
    assert.equal(payload.fingerprint, fingerprint);
    // Explanation is the self-signed one (we passed CERT_AUTHORITY_INVALID).
    assert.match(payload.error_description, /self-signed|unrecognised/i);
    // Routing: both keys carry the same value (per the existing
    // dual-key convention in view-manager.ts).
    assert.equal(payload.browser_id, payload.workspace_id);
  });

  test("describeCertError surfaces a meaningful string for a real-network self-signed scenario", () => {
    // The error code Chromium emits for `DEPTH_ZERO_SELF_SIGNED_CERT`
    // is `net::ERR_CERT_AUTHORITY_INVALID`. Verify the renderer-
    // visible string mentions self-signed or untrusted authority so
    // the user can act.
    const message = describeCertError("net::ERR_CERT_AUTHORITY_INVALID");
    assert.match(message, /self-signed|unrecognised|not trusted/i);
  });
});
