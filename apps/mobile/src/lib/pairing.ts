/**
 * Turns what a user scans or opens into a hub URL and token. Two inputs carry a pairing:
 *
 * - the sign-in link Settings > Devices shows as a QR code, `<hubPublicUrl>/?token=bdt_…`
 *   (`DevicesSettings.tsx`);
 * - the app's deep link, `band://pair?url=<hub URL>&token=<token>`, which tests use instead of
 *   the camera and which a person can open too.
 *
 * Both give the same `{ url, token }`. No React Native imports, so the tests run under Node.
 */

export interface Pairing {
  /** The hub's origin, with no path or trailing slash. */
  url: string;
  token: string;
}

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

function withToken(rawUrl: string, token: string | null): ParseResult<Pairing> {
  const t = token?.trim();
  if (!t) return { ok: false, error: "The link has no token" };
  const url = parseHubUrl(rawUrl);
  if (!url.ok) return url;
  return { ok: true, value: { url: url.value, token: t } };
}

/** The pairing in a Settings > Devices QR code: `<hubPublicUrl>/?token=bdt_…`. */
export function parseSignInUrl(raw: string): ParseResult<Pairing> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "This QR code is not a Band sign-in link" };
  }
  return withToken(url.origin, url.searchParams.get("token"));
}

/** The pairing in a deep link: `band://pair?url=<hub URL>&token=<token>`. */
export function parsePairLink(params: {
  url?: string | null;
  token?: string | null;
}): ParseResult<Pairing> {
  if (!params.url) return { ok: false, error: "The link has no hub URL" };
  return withToken(params.url, params.token ?? null);
}
