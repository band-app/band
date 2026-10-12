/**
 * The hub's typed tRPC client, built from a URL, a token and the platform's
 * own `fetch` and `WebSocket`. The package touches no globals, so the web UI
 * and the mobile app each pass in what their runtime provides.
 *
 * Auth matches `apps/web/src/lib/hub-config.ts`: `Authorization: Bearer
 * <token>` on HTTP, and the `["band", "band-token.<token>"]` subprotocol on
 * WebSockets, which cannot set headers in a browser.
 */

import type { AppRouter } from "@band-app/server";
import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";

const WS_BASE_PROTOCOL = "band";
const WS_TOKEN_PROTOCOL_PREFIX = "band-token.";

/** `fetch` taking a hub path (`/api/...`) or a full URL. */
export type HubFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HubClientOptions {
  /** The hub's origin, without a trailing slash. An empty string means same-origin (relative HTTP URLs). */
  hubUrl: string;
  /** Sent as the Bearer token and the WebSocket subprotocol. Omit when a cookie authenticates. */
  token?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /**
   * The WebSocket URL, resolved when the socket opens. Defaults to `hubUrl`
   * with `http` swapped for `ws`; same-origin callers (empty `hubUrl`) must
   * pass it.
   */
  wsUrl?: string | (() => string);
}

export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws");
}

/** The subprotocol list that authenticates a WebSocket to the hub. */
export function tokenProtocols(token: string | undefined, protocols?: string | string[]): string[] {
  const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
  // A token outside the subprotocol character set makes `new WebSocket` throw with the token in the message.
  if (!token || !/^[A-Za-z0-9._~-]+$/.test(token)) return list;
  const rest = list.filter((p) => p !== WS_BASE_PROTOCOL);
  return [WS_BASE_PROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${token}`, ...rest];
}

function isHubUrl(url: string, hubUrl: string): boolean {
  if (!hubUrl) return false;
  try {
    return new URL(url).origin === new URL(hubUrl).origin;
  } catch {
    return false;
  }
}

/** `fetch` that resolves hub paths against `hubUrl` and adds the Bearer header. */
export function createHubFetch(options: Pick<HubClientOptions, "hubUrl" | "token" | "fetch">) {
  const { hubUrl, token } = options;
  const doFetch = options.fetch ?? fetch;
  const hubFetch: HubFetch = (input, init) => {
    const url = input.startsWith("/") ? `${hubUrl}${input}` : input;
    const headers = new Headers(init?.headers);
    // Never send the token to another origin, e.g. an absolute URL a server supplied.
    if (token && (input.startsWith("/") || isHubUrl(url, hubUrl))) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return doFetch(url, { ...init, headers });
  };
  return hubFetch;
}

/**
 * The tRPC client plus a `close()` that shuts its WebSocket. A caller that rebuilds the client
 * (the mobile app does, when it returns to the foreground) closes the old one first.
 */
export function createHubConnection(options: HubClientOptions) {
  const { hubUrl, token } = options;
  const WebSocketImpl = options.WebSocket ?? WebSocket;

  class HubWebSocket extends WebSocketImpl {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, tokenProtocols(token, protocols));
    }
  }

  const hubFetch = createHubFetch(options);
  const wsUrl = options.wsUrl ?? (() => toWsUrl(`${hubUrl}/trpc`));
  const wsClient = createWSClient({
    url: typeof wsUrl === "function" ? wsUrl : () => wsUrl,
    WebSocket: HubWebSocket,
  });

  const client = createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: wsLink({ client: wsClient }),
        // Keep maxURLLength in sync with WebDashboardAdapter (apps/web/src/dashboard/adapters/web.ts) — issue #430.
        false: httpBatchLink({
          url: `${hubUrl}/trpc`,
          maxURLLength: 2000,
          fetch: (url, init) => hubFetch(String(url), init as RequestInit),
        }),
      }),
    ],
  });
  return { client, close: () => void wsClient.close() };
}

export function createHubClient(options: HubClientOptions) {
  return createHubConnection(options).client;
}

export type HubClient = ReturnType<typeof createHubClient>;
