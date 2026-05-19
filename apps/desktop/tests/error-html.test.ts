/**
 * Tests for the in-WebContentsView error page HTML and the
 * `band-action://` URL parser (issue #444 — cast follow-up).
 *
 * The HTML is loaded into the WebContentsView via a `data:` URI;
 * its button clicks become `band-action://…` navigations that the
 * view manager intercepts via `will-navigate`. So the things worth
 * exercising are:
 *
 *   - HTML output contains the user-facing strings (host, error
 *     code, headline, description) so the cast viewer can read them.
 *   - User-controlled content is HTML-escaped to defeat injection
 *     via e.g. a malicious hostname or cert subject.
 *   - `band-action://` URLs round-trip through `parseBandAction` and
 *     produce the expected typed actions.
 *   - Malformed `band-action://` URLs (missing params, unknown
 *     actions, wrong scheme) return `null` so the receiver never
 *     dispatches on incomplete data.
 *
 * No Electron deps — runs under `node:test`.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  buildCertErrorHtml,
  buildLoadErrorHtml,
  htmlToDataUrl,
  parseBandAction,
} from "../src/browser/error-html.ts";

describe("buildCertErrorHtml", () => {
  test("renders the host, error code, and explanation", () => {
    const html = buildCertErrorHtml({
      url: "https://example.com/login",
      host: "example.com",
      errorCode: "net::ERR_CERT_AUTHORITY_INVALID",
      errorDescription: "The certificate is not trusted by your computer.",
      certificate: {
        fingerprint: "sha256/abc123",
        subjectName: "CN=example.com",
        issuerName: "CN=example.com",
      },
    });
    assert.match(html, /Your connection is not private/);
    assert.match(html, /example\.com/);
    assert.match(html, /net::ERR_CERT_AUTHORITY_INVALID/);
    assert.match(html, /The certificate is not trusted/);
    // Fingerprint shows up in the details panel.
    assert.match(html, /sha256\/abc123/);
  });

  test("emits band-action:// links for Proceed and Back", () => {
    const html = buildCertErrorHtml({
      url: "https://example.com",
      host: "example.com",
      errorCode: "CERT_AUTHORITY_INVALID",
      errorDescription: "Self-signed.",
      certificate: { fingerprint: "sha256/abc" },
    });
    assert.match(html, /band-action:\/\/cert-back/);
    // The `&` in the query string is HTML-escaped to `&amp;` in
    // the href attribute. Browsers correctly decode that back to
    // `&` when navigating, so the actual URL the receiver sees is
    // `band-action://cert-proceed?host=...&fingerprint=...`.
    assert.match(
      html,
      /band-action:\/\/cert-proceed\?host=example\.com&amp;fingerprint=sha256%2Fabc/,
    );
  });

  test("HTML-escapes user-controlled hostnames (XSS guard)", () => {
    const html = buildCertErrorHtml({
      url: "https://evil.example",
      host: 'evil"<img src=x onerror=alert(1)>',
      errorCode: "CERT",
      errorDescription: "Self-signed.",
      certificate: { fingerprint: "sha256/abc" },
    });
    // The raw `<img>` and unescaped quote must not appear in the
    // body content — the hostname is interpolated into the
    // headline as plain text, so anything injected there has to
    // come through escaped.
    assert.equal(html.includes("<img src=x onerror=alert(1)>"), false);
    assert.equal(html.includes('evil"<img'), false);
    assert.match(html, /&lt;img/);
    assert.match(html, /&quot;/);
  });

  test("HTML-escapes cert subject / issuer", () => {
    const html = buildCertErrorHtml({
      url: "https://example.com",
      host: "example.com",
      errorCode: "CERT",
      errorDescription: "ok",
      certificate: {
        fingerprint: "sha256/abc",
        subjectName: 'CN=<svg onload="alert(1)">',
        issuerName: "CN=Real CA",
      },
    });
    assert.equal(html.includes('<svg onload="alert(1)">'), false);
    assert.match(html, /&lt;svg/);
  });
});

describe("buildLoadErrorHtml", () => {
  test("renders the URL, headline, and description", () => {
    const html = buildLoadErrorHtml({
      url: "https://nonexistent.example/foo",
      errorCode: -105,
      errorName: "ERR_NAME_NOT_RESOLVED",
      headline: "This site can't be reached",
      description: "The server DNS address could not be found.",
    });
    // Apostrophe gets HTML-escaped to `&#39;` in the rendered output.
    assert.match(html, /This site can(?:'|&#39;)t be reached/);
    assert.match(html, /https:\/\/nonexistent\.example\/foo/);
    assert.match(html, /ERR_NAME_NOT_RESOLVED/);
    assert.match(html, /DNS address could not be found/);
  });

  test("emits band-action:// links for Reload and Back", () => {
    const html = buildLoadErrorHtml({
      url: "https://example.com",
      errorCode: -105,
      errorName: "ERR_NAME_NOT_RESOLVED",
      headline: "Boom",
      description: "x",
    });
    assert.match(html, /band-action:\/\/load-retry/);
    assert.match(html, /band-action:\/\/load-back/);
  });

  test("escapes URL and headline (XSS guard)", () => {
    const html = buildLoadErrorHtml({
      url: "https://evil/<script>alert(1)</script>",
      errorCode: -1,
      errorName: "ERR_X",
      headline: "<img src=x>",
      description: "<svg onload=alert(1)>",
    });
    assert.equal(html.includes("<script>alert(1)</script>"), false);
    assert.equal(html.includes("<img src=x>"), false);
    assert.equal(html.includes("<svg onload=alert(1)>"), false);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img/);
    assert.match(html, /&lt;svg/);
  });
});

describe("htmlToDataUrl", () => {
  test("produces a base64 data URL Chromium can load", () => {
    const url = htmlToDataUrl("<h1>hi</h1>");
    assert.ok(url.startsWith("data:text/html;charset=utf-8;base64,"));
    const b64 = url.slice("data:text/html;charset=utf-8;base64,".length);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    assert.equal(decoded, "<h1>hi</h1>");
  });

  test("round-trips multibyte content (UTF-8 safe)", () => {
    const html = "<p>héllo — 你好 ✨</p>";
    const url = htmlToDataUrl(html);
    const b64 = url.slice("data:text/html;charset=utf-8;base64,".length);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    assert.equal(decoded, html);
  });
});

describe("parseBandAction", () => {
  test("cert-proceed extracts host and fingerprint", () => {
    const action = parseBandAction(
      "band-action://cert-proceed?host=example.com&fingerprint=sha256%2Fabc",
    );
    assert.deepEqual(action, {
      kind: "cert-proceed",
      host: "example.com",
      fingerprint: "sha256/abc",
    });
  });

  test("cert-back parses cleanly", () => {
    assert.deepEqual(parseBandAction("band-action://cert-back"), { kind: "cert-back" });
  });

  test("load-retry parses cleanly", () => {
    assert.deepEqual(parseBandAction("band-action://load-retry"), { kind: "load-retry" });
  });

  test("load-back parses cleanly", () => {
    assert.deepEqual(parseBandAction("band-action://load-back"), { kind: "load-back" });
  });

  test("cert-proceed without host returns null (defensive)", () => {
    assert.equal(parseBandAction("band-action://cert-proceed?fingerprint=abc"), null);
  });

  test("cert-proceed without fingerprint returns null (defensive)", () => {
    assert.equal(parseBandAction("band-action://cert-proceed?host=example.com"), null);
  });

  test("unknown action returns null", () => {
    assert.equal(parseBandAction("band-action://nope"), null);
  });

  test("wrong scheme returns null (no false positives on http/https)", () => {
    assert.equal(parseBandAction("https://example.com/band-action://cert-back"), null);
    assert.equal(parseBandAction("about:blank"), null);
  });

  test("malformed URLs don't throw", () => {
    assert.equal(parseBandAction("band-action://"), null);
    assert.equal(parseBandAction("band-action:"), null);
    assert.equal(parseBandAction("not a url"), null);
    assert.equal(parseBandAction(undefined as unknown as string), null);
  });

  test("tolerates Chromium normalising the authority-slashes away", () => {
    // Some Chromium versions report `band-action://cert-back` as
    // `band-action:cert-back` to `did-start-navigation`. We must
    // recognise both.
    assert.deepEqual(parseBandAction("band-action:cert-back"), { kind: "cert-back" });
    assert.deepEqual(
      parseBandAction("band-action:cert-proceed?host=example.com&fingerprint=sha256%2Fabc"),
      { kind: "cert-proceed", host: "example.com", fingerprint: "sha256/abc" },
    );
  });

  test("tolerates a trailing slash on the action name", () => {
    assert.deepEqual(parseBandAction("band-action://cert-back/"), { kind: "cert-back" });
    assert.deepEqual(parseBandAction("band-action://load-retry/"), { kind: "load-retry" });
    assert.deepEqual(
      parseBandAction("band-action://cert-proceed/?host=example.com&fingerprint=sha256%2Fabc"),
      { kind: "cert-proceed", host: "example.com", fingerprint: "sha256/abc" },
    );
  });
});
