/**
 * Turns what a user scans or opens into a hub URL and a credential. Settings > Devices shows
 * a pairing link as a QR code, and the app's deep link carries the same thing:
 *
 * - `<address>/?pair=bdp_…` and `band://pair?url=<address>&code=bdp_…` hold a one-time
 *   pairing code, which `exchangePairingCode` trades for the device's token;
 * - `<address>/?token=bdt_…` and `band://pair?url=<address>&token=<token>` are the older
 *   links that carry the token itself. They still work.
 *
 * No React Native imports, so the tests run under Node.
 */

export interface Pairing {
  /** The hub's origin, with no path or trailing slash. */
  url: string;
  token: string;
}

/** What a link carries: the token itself, or a pairing code to exchange for one. */
export type PairingInput = Pairing | { url: string; code: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

function isPrivateIPv4(hostname: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // Carrier-grade NAT space, which Tailscale hands out.
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIPv6(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/**
 * Whether plain http is allowed for this host. iOS App Transport Security lets the app load
 * http only from local addresses (`NSAllowsLocalNetworking`): loopback, private LAN ranges and
 * `.local` names. Every other hub needs https, as in the desktop app.
 */
export function allowsPlainHttp(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return isLoopback(h) || isPrivateIPv4(h) || isPrivateIPv6(h) || h.endsWith(".local");
}

/** The origin of a hub URL a person typed or a link carried, or why it can't be used. */
export function parseHubUrl(raw: string): ParseResult<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Enter a full URL, for example https://hub.example.com" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "The hub URL must start with https:// or http://" };
  }
  if (url.protocol === "http:" && !allowsPlainHttp(url.hostname)) {
    return { ok: false, error: "A hub outside your local network needs an https:// URL" };
  }
  return { ok: true, value: url.origin };
}

function withCredential(
  rawUrl: string,
  token: string | null,
  code: string | null,
): ParseResult<PairingInput> {
  const url = parseHubUrl(rawUrl);
  const c = code?.trim();
  if (c) return url.ok ? { ok: true, value: { url: url.value, code: c } } : url;
  const t = token?.trim();
  if (!t) return { ok: false, error: "The link has no pairing code or token" };
  return url.ok ? { ok: true, value: { url: url.value, token: t } } : url;
}

/** The pairing in a Settings > Devices QR code: `<address>/?pair=bdp_…` or the older `<address>/?token=bdt_…`. */
export function parseSignInUrl(raw: string): ParseResult<PairingInput> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "This QR code is not a Band sign-in link" };
  }
  return withCredential(url.origin, url.searchParams.get("token"), url.searchParams.get("pair"));
}

/** The pairing in a deep link: `band://pair?url=<address>&code=<code>`, or the older `&token=<token>`. */
export function parsePairLink(params: {
  url?: string | null;
  token?: string | null;
  code?: string | null;
}): ParseResult<PairingInput> {
  if (!params.url) return { ok: false, error: "The link has no hub URL" };
  return withCredential(params.url, params.token ?? null, params.code ?? null);
}

export const PAIRING_REFUSED = "This link was already used or has expired. Ask for a new one.";

/**
 * Trades a pairing code for the device's token with `POST /api/pair/exchange`, which works
 * once. A token link passes through unchanged. Nothing is saved here, so a refusal leaves the
 * app as it was.
 */
export async function exchangePairingCode(
  input: PairingInput,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<ParseResult<Pairing>> {
  if ("token" in input) return { ok: true, value: input };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${input.url}/api/pair/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ code: input.code }),
      signal: controller.signal,
    });
    if (res.status === 401) return { ok: false, error: PAIRING_REFUSED };
    const body = res.ok
      ? ((await res.json().catch(() => null)) as { token?: unknown } | null)
      : null;
    if (typeof body?.token !== "string" || body.token === "") {
      return { ok: false, error: `The hub answered with HTTP ${res.status}` };
    }
    return { ok: true, value: { url: input.url, token: body.token } };
  } catch {
    return { ok: false, error: `Could not reach the hub at ${input.url}` };
  } finally {
    clearTimeout(timer);
  }
}
