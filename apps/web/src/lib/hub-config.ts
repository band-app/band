/**
 * Where the hub is, and how to authenticate to it.
 *
 * By default the UI is served by the hub, so every request is same-origin and
 * the `band_token` cookie authenticates it. When the UI is served from
 * somewhere else (a static host, another port, Electron's bundled files) it
 * needs the hub's URL and token. They come from, in order:
 *
 * 1. `window.__BAND_HUB__ = { url, token }`, set by a host page or shell
 * 2. `localStorage["band.hub"]`, a JSON `{ url, token }`
 * 3. a `#hub=<url>&token=<token>` fragment on the page URL. It is stored in
 *    localStorage and removed from the address bar. A fragment is never sent
 *    to a server, so the token stays out of access logs.
 *
 * Cross-origin requests send `Authorization: Bearer <token>` with
 * credentials off. WebSockets send the token as the `band-token.<token>`
 * subprotocol, because browsers can't set headers on them.
 */

const STORAGE_KEY = "band.hub";
const WS_BASE_PROTOCOL = "band";
const WS_TOKEN_PROTOCOL_PREFIX = "band-token.";

export interface HubConfig {
  url: string;
  token?: string;
}

declare global {
  interface Window {
    __BAND_HUB__?: HubConfig;
  }
}

function normalizeUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

interface StoredHub {
  url: string;
  /** Tokens by hub origin. A token is only ever sent to the origin it was saved for. */
  tokens: Record<string, string>;
}

function readStored(): StoredHub | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { url?: unknown; token?: unknown; tokens?: unknown };
    if (typeof parsed.url !== "string") return null;
    const tokens: Record<string, string> = {};
    if (parsed.tokens && typeof parsed.tokens === "object") {
      for (const [origin, token] of Object.entries(parsed.tokens)) {
        if (typeof token === "string") tokens[origin] = token;
      }
    }
    // Older format: one token for the one stored URL.
    const legacyOrigin = normalizeUrl(parsed.url);
    if (typeof parsed.token === "string" && legacyOrigin && !(legacyOrigin in tokens)) {
      tokens[legacyOrigin] = parsed.token;
    }
    return { url: parsed.url, tokens };
  } catch {
    return null;
  }
}

/**
 * A `#hub=` link switches the hub URL. The token stored for another origin
 * stays with that origin and is never sent to the new one; the link must carry
 * a token for the new hub, otherwise requests to it go out without one.
 */
function consumeFragment(): void {
  if (typeof window === "undefined" || !window.location.hash.includes("hub=")) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const url = params.get("hub");
  const origin = url ? normalizeUrl(url) : null;
  if (!url || !origin) return;
  const token = params.get("token") ?? undefined;
  try {
    const tokens = { ...readStored()?.tokens };
    if (token) tokens[origin] = token;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ url, tokens }));
  } catch {
    // Storage blocked: the config only lasts for this page load.
    window.__BAND_HUB__ = { url, token };
  }
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}`);
}

function readConfig(): HubConfig | null {
  if (typeof window === "undefined") return null;
  if (window.__BAND_HUB__?.url) return window.__BAND_HUB__;
  const stored = readStored();
  if (!stored) return null;
  const origin = normalizeUrl(stored.url);
  return { url: stored.url, token: origin ? stored.tokens[origin] : undefined };
}

consumeFragment();

/** Persist a hub URL and token. Reload the page to apply it. */
export function setHubConfig(config: HubConfig | null): void {
  try {
    const origin = config ? normalizeUrl(config.url) : null;
    if (config && origin) {
      const tokens = { ...readStored()?.tokens };
      if (config.token) tokens[origin] = config.token;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: config.url, tokens }));
    } else if (!config) localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked; nothing to persist to.
  }
}

/** The hub's origin when it differs from the page's, otherwise `null`. */
export function crossOriginHub(): { origin: string; token?: string } | null {
  const config = readConfig();
  if (!config) return null;
  const origin = normalizeUrl(config.url);
  if (!origin || origin === window.location.origin) return null;
  // A token outside the subprotocol token set would make `new WebSocket` throw.
  const token = config.token && /^[A-Za-z0-9._~-]+$/.test(config.token) ? config.token : undefined;
  return { origin, token };
}

/** Absolute URL for a hub path (`/trpc`, `/api/...`). Unchanged when same-origin. */
export function hubUrl(path: string): string {
  const hub = crossOriginHub();
  return hub ? `${hub.origin}${path}` : path;
}

export function hubWsUrl(path: string): string {
  const hub = crossOriginHub();
  if (hub) return `${hub.origin.replace(/^http/, "ws")}${path}`;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

/**
 * URL for an element that can't send headers (`<img>`, `<a download>`). When
 * the hub is on another origin the token goes in the query string, which the
 * hub accepts for these GETs. Server-supplied paths such as
 * `/api/uploads/<name>` go through here.
 */
export function hubAssetUrl(path: string): string {
  const hub = crossOriginHub();
  if (!hub || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
  const url = new URL(path, hub.origin);
  // Never attach the token to a URL that left the hub's origin.
  if (url.origin !== hub.origin) return path;
  if (hub.token) url.searchParams.set("token", hub.token);
  return url.toString();
}

/** `fetch` for hub requests: Bearer and no credentials when cross-origin. */
export function hubFetch(input: string, init?: RequestInit): Promise<Response> {
  const hub = crossOriginHub();
  // Same-origin: the cookie authenticates, and a caller may override credentials.
  // Cross-origin (below): credentials are always off, Bearer is the only auth.
  if (!hub) return fetch(input, { credentials: "include", ...init });
  const headers = new Headers(init?.headers);
  if (hub.token) headers.set("Authorization", `Bearer ${hub.token}`);
  return fetch(input.startsWith("/") ? `${hub.origin}${input}` : input, {
    ...init,
    headers,
    credentials: "omit",
  });
}

function withTokenProtocol(protocols?: string | string[]): string[] {
  const hub = crossOriginHub();
  const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
  if (!hub?.token) return list;
  const rest = list.filter((p) => p !== WS_BASE_PROTOCOL);
  return [WS_BASE_PROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${hub.token}`, ...rest];
}

/** A WebSocket that authenticates to a cross-origin hub through its subprotocol. */
export class HubWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, withTokenProtocol(protocols));
  }
}
