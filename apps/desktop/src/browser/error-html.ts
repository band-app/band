/**
 * Standalone HTML templates for the in-WebContentsView error pages
 * (issue #444 + cast follow-up).
 *
 * The error pages render INSIDE the WebContentsView (via a `data:`
 * URI) rather than as a React overlay above it. Two reasons:
 *
 *   1. The native `WebContentsView` is an OS-level compositor layer
 *      that paints on top of the dashboard's React DOM. Overlay
 *      approaches need to `setVisible(false)` the view, which
 *      throttles Chromium's load pipeline and races against the
 *      renderer's state-change effects.
 *   2. When the browser is being **cast** via Band's CDP screencast
 *      feature, the screencast captures the WebContentsView's
 *      content, NOT the dashboard chrome above it. A React-overlay
 *      interstitial would be invisible to remote viewers — they'd
 *      see a blank cert-blocked page and have no way to Proceed.
 *      Rendering inside the view itself makes the error page part of
 *      the screencast, so the cast workflow stays usable.
 *
 * Button actions are encoded as navigations to `band-action://`
 * URLs; a `will-navigate` listener in `view-manager.ts` intercepts
 * those, prevents the navigation, and dispatches to the matching
 * `BrowserViewManager` method.
 *
 * No Electron imports — these helpers are pure HTML / string
 * manipulation and run unchanged under `node:test`.
 */

import type { CertificateLike } from "./cert-error.js";

/**
 * HTML-escape a string for safe interpolation into the template.
 * The fields we inline are operator-controlled (URL, host) or
 * cert-controlled (subjectName, issuerName, fingerprint) — neither
 * of those is trusted input, so we treat both as user data and
 * escape every special character.
 *
 * `&` must come first to avoid double-encoding ampersands the other
 * replacements introduce.
 */
function escapeHtml(s: string | undefined): string {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Encode a string for safe interpolation into a query-string
 * component of a `band-action://` URL. Standard URI component
 * encoding, but extracted for readability at the call sites.
 */
function q(s: string | undefined): string {
  return encodeURIComponent(s ?? "");
}

/**
 * Format a Chromium-reported validity timestamp (seconds since epoch,
 * occasionally milliseconds in some Electron builds) as a human-
 * readable date string. Returns the raw value if it can't be parsed
 * so the user always sees something rather than a NaN.
 */
function formatCertDate(value: number | undefined): string {
  if (value === undefined || value === null) return "";
  // 1e10 seconds = year 2286; anything bigger has to be ms already.
  const ms = value > 1e10 ? value : value * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toUTCString();
}

/**
 * Shared layout shell. Inline CSS keeps the data: URI self-contained
 * — no external requests, which is important because a data: URI
 * gets a unique opaque origin and can't fetch anything anyway.
 *
 * Color scheme uses both light and dark via `prefers-color-scheme`
 * so the page looks reasonable regardless of the user's OS setting.
 * We don't have access to the dashboard's theme variables from inside
 * the view, so we ship our own palette.
 */
function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #111827;
    --muted: #6b7280;
    --border: #e5e7eb;
    --surface: #f9fafb;
    --primary: #111827;
    --primary-fg: #ffffff;
    --danger: #dc2626;
    --danger-bg: #fee2e2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0f14;
      --fg: #e5e7eb;
      --muted: #9ca3af;
      --border: #1f2937;
      --surface: #111827;
      --primary: #e5e7eb;
      --primary-fg: #0b0f14;
      --danger: #f87171;
      --danger-bg: #1f1212;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-size: 14px; line-height: 1.5; }
  body { display: flex; align-items: center; justify-content: center; padding: 32px; overflow: auto; }
  main { width: 100%; max-width: 640px; }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 8px 0; }
  p { margin: 0 0 12px 0; color: var(--muted); }
  p.body { color: var(--fg); opacity: 0.8; }
  code { background: var(--surface); border: 1px solid var(--border); padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
  .icon { font-size: 40px; line-height: 1; margin-bottom: 12px; }
  .icon.danger { color: var(--danger); }
  .icon.muted { color: var(--muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0; }
  /* .btn is applied to both <button> (the in-page toggle for the
     Advanced section) and <a> (links that navigate to band-action://
     URLs). HTML5 forbids interactive content nested inside an <a>,
     so we cannot use the simpler <a><button>...</button></a> form. */
  .btn, button { font: inherit; padding: 8px 16px; border-radius: 6px; cursor: pointer; transition: filter 0.1s; display: inline-block; text-decoration: none; }
  .btn:hover, button:hover { filter: brightness(0.95); }
  .btn.primary, button.primary { background: var(--primary); color: var(--primary-fg); border: 1px solid var(--primary); }
  .btn.secondary, button.secondary { background: var(--bg); color: var(--fg); border: 1px solid var(--border); }
  .details { display: none; border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--surface); margin-top: 12px; }
  .details.open { display: block; }
  .details .warning { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 12px; }
  .details .warning .ico { color: var(--danger); flex-shrink: 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 12px 0; font-size: 12px; }
  dt { font-weight: 500; color: var(--muted); }
  dd { margin: 0; color: var(--fg); word-break: break-all; }
  dd.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .proceed-link { display: inline-block; margin-top: 12px; color: var(--danger); text-decoration: none; font-weight: 500; cursor: pointer; }
  .proceed-link:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>${bodyHtml}</main>
<script>
(function() {
  // Toggle the Advanced details panel without navigating. We keep
  // this inline because data: URIs can't reference external scripts.
  var btn = document.getElementById("advanced");
  if (btn) {
    btn.addEventListener("click", function () {
      var d = document.getElementById("details");
      if (!d) return;
      var open = d.classList.toggle("open");
      btn.textContent = open ? "Hide details" : "Advanced";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
})();
</script>
</body>
</html>`;
}

/**
 * Build the Chrome-style cert-error interstitial page. Action links
 * navigate to `band-action://cert-back` and
 * `band-action://cert-proceed?host=...&fingerprint=...` — see
 * `view-manager.ts::wireBandActionInterceptor` for the receiver.
 */
export function buildCertErrorHtml(args: {
  url: string;
  host: string;
  errorCode: string;
  errorDescription: string;
  certificate: CertificateLike;
}): string {
  const subject = escapeHtml(args.certificate.subjectName);
  const issuer = escapeHtml(args.certificate.issuerName);
  const fingerprint = escapeHtml(args.certificate.fingerprint);
  const validStart = escapeHtml(formatCertDate(args.certificate.validStart));
  const validExpiry = escapeHtml(formatCertDate(args.certificate.validExpiry));
  const host = escapeHtml(args.host || args.url);
  const proceedHref = `band-action://cert-proceed?host=${q(args.host)}&fingerprint=${q(args.certificate.fingerprint)}`;
  const backHref = "band-action://cert-back";

  const detailRows = [
    args.certificate.subjectName ? `<dt>Subject</dt><dd>${subject}</dd>` : "",
    args.certificate.issuerName ? `<dt>Issuer</dt><dd>${issuer}</dd>` : "",
    `<dt>Fingerprint</dt><dd class="mono">${fingerprint}</dd>`,
    args.certificate.validStart !== undefined ? `<dt>Valid from</dt><dd>${validStart}</dd>` : "",
    args.certificate.validExpiry !== undefined ? `<dt>Valid until</dt><dd>${validExpiry}</dd>` : "",
  ]
    .filter(Boolean)
    .join("");

  const body = `
    <div class="icon danger">⚠</div>
    <h1>Your connection is not private</h1>
    <p>
      Attackers might be trying to steal your information from
      <strong>${host}</strong> (for example, passwords, messages, or credit cards).
    </p>
    <p class="body">${escapeHtml(args.errorDescription)}</p>
    <p><code>${escapeHtml(args.errorCode)}</code></p>
    <div class="actions">
      <a href="${escapeHtml(backHref)}" class="btn primary">Back to safety</a>
      <button type="button" id="advanced" class="secondary" aria-expanded="false">Advanced</button>
    </div>
    <section id="details" class="details">
      <div class="warning">
        <span class="ico">⚠</span>
        <p>
          This server could not prove that it is <strong>${host}</strong> — its
          security certificate is not trusted by your computer. This may be
          caused by a misconfiguration or an attacker intercepting your
          connection.
        </p>
      </div>
      <dl>${detailRows}</dl>
      <a href="${escapeHtml(proceedHref)}" class="proceed-link">Proceed to ${host} (unsafe)</a>
    </section>
  `;

  return shell("Your connection is not private", body);
}

/**
 * Build the Chrome-style "This site can't be reached" page. Action
 * links navigate to `band-action://load-retry` and
 * `band-action://load-back`.
 */
export function buildLoadErrorHtml(args: {
  url: string;
  errorCode: number;
  errorName: string;
  headline: string;
  description: string;
}): string {
  const body = `
    <div class="icon muted">🌐</div>
    <h1>${escapeHtml(args.headline)}</h1>
    <p style="word-break: break-all;">${escapeHtml(args.url)}</p>
    <p class="body">${escapeHtml(args.description)}</p>
    <p><code>${escapeHtml(args.errorName)}</code></p>
    <div class="actions">
      <a href="band-action://load-retry" class="btn primary">Reload</a>
      <a href="band-action://load-back" class="btn secondary">Back</a>
    </div>
  `;

  return shell(args.headline, body);
}

/**
 * Convert raw HTML into a `data:` URL suitable for
 * `webContents.loadURL`. We use base64 rather than URL-encoded
 * percent-encoding so the URL stays compact for big HTML payloads
 * and side-steps any quoting edge cases inside the HTML body
 * (inline JS, attribute values, etc.).
 */
export function htmlToDataUrl(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

/**
 * Recognised receiver for `band-action://` URLs the in-view error
 * pages navigate to. Centralised so `view-manager.ts` can pattern-
 * match on a stable enum rather than string-matching everywhere.
 */
export type BandAction =
  | { kind: "cert-proceed"; host: string; fingerprint: string }
  | { kind: "cert-back" }
  | { kind: "load-retry" }
  | { kind: "load-back" };

/**
 * Parse a `band-action://...` URL into one of the recognised
 * actions, or `null` if the URL doesn't match a known shape.
 * Returns `null` for missing or empty `host` / `fingerprint`
 * parameters on `cert-proceed` so a malformed link can't trigger
 * an incomplete exception write.
 *
 * **Tolerant parsing.** Chromium can normalise non-standard URL
 * schemes inconsistently between the version we author the HTML
 * link as (`band-action://cert-proceed?…`) and the version
 * `did-start-navigation` reports back to us — observed
 * normalisations include dropping the authority slashes
 * (`band-action:cert-proceed?…`) and adding a trailing slash to
 * the path (`band-action://cert-proceed/?…`). We don't rely on
 * `new URL()` because for unknown schemes its host/pathname split
 * is platform-dependent and on some Chromium versions returns an
 * empty host — instead we slice the scheme prefix, split on `?`,
 * strip slashes from the action name, and parse the query
 * manually.
 */
export function parseBandAction(rawUrl: string): BandAction | null {
  if (typeof rawUrl !== "string") return null;
  let body: string;
  if (rawUrl.startsWith("band-action://")) {
    body = rawUrl.slice("band-action://".length);
  } else if (rawUrl.startsWith("band-action:")) {
    body = rawUrl.slice("band-action:".length);
  } else {
    return null;
  }
  const queryStart = body.indexOf("?");
  const rawAction = queryStart === -1 ? body : body.slice(0, queryStart);
  const queryString = queryStart === -1 ? "" : body.slice(queryStart + 1);
  // Strip leading + trailing `/` so `cert-proceed` and
  // `cert-proceed/` both match.
  const action = rawAction.replace(/^\/+|\/+$/g, "");
  if (!action) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(queryString);
  } catch {
    return null;
  }
  switch (action) {
    case "cert-proceed": {
      const host = params.get("host");
      const fingerprint = params.get("fingerprint");
      if (!host || !fingerprint) return null;
      return { kind: "cert-proceed", host, fingerprint };
    }
    case "cert-back":
      return { kind: "cert-back" };
    case "load-retry":
      return { kind: "load-retry" };
    case "load-back":
      return { kind: "load-back" };
    default:
      return null;
  }
}
