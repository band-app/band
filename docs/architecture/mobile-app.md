# ADR: native mobile app and a shared client package

**Status:** Accepted · **Date:** 2026-10-12

## Context

Band's phone experience is the web UI in a mobile browser or as a PWA. iOS suspends a backgrounded PWA and kills its SSE stream silently, push notifications are limited, and a terminal, a code editor and a VNC viewer are poor fits for a browser tab on a phone. The hub already exposes everything a client needs over a public API (tRPC, the chat SSE stream, REST routes), so a second client needs no hub change.

## Decision

1. **Native React Native with Expo.** The app lives in `apps/mobile`: Expo with the new architecture, expo-router and Hermes. One codebase serves iOS and Android. iOS comes first.
2. **No WebView for app UI.** A WebView is only for web content: previews of dev servers, tunnels and HTML files, offscreen Mermaid-to-SVG rendering, and possibly the side tabs of third-party plugins.
3. **Native modules for heavy surfaces, later.** Terminal: SwiftTerm on iOS and Termux terminal-view on Android. Editor: Runestone and Sora Editor. VNC: RoyalVNCKit. Each arrives as its own phase.
4. **Push through the Expo push service.** This comes in a later phase and needs a hub-side token registry, which is out of scope here.
5. **Shared logic lives in `packages/client` (`@band-app/client`).** The web UI and the mobile app import the same chat transcript reducer, chat stream reader, client-state store, center-tab rules and tRPC client factory, so the two cannot drift. The package has no DOM, no React, no React Native and no global such as `window`, `localStorage` or `EventSource`. Each client passes in `fetch`, `WebSocket`, a storage backend and the device type. `packages/client/tests/purity.test.ts` fails when a UI package or one of those globals appears in its sources or dependencies.
6. **Same boundary rule as `apps/web`.** The mobile app talks to the hub only over the public API and may use `import type { AppRouter } from "@band-app/server"` and nothing else from the hub. `apps/web/tests/hub-boundary.test.ts` enforces this for the UI. `@band-app/client` follows it, and `apps/mobile` will be added to the same check.

## CORS and `Origin`

No CORS change is needed. `classifyOrigin` in `apps/hub/cors.ts` returns `none` for a request without an `Origin` header, and such a request is not subject to the allowlist. The Expo networking layer sends no `Origin` on `fetch`, and React Native's `WebSocket` sends none by default, the same as the CLI and curl. A native client authenticates with `Authorization: Bearer <device token>` on HTTP and with the `["band", "band-token.<token>"]` subprotocol on WebSockets, exactly as a cross-origin browser client does through `hub-config.ts`. If a future React Native version starts sending an `Origin`, the hub's `BAND_CORS_ORIGINS` list is the place to allow it, not a code change.

## What moved into `@band-app/client`

- `hub-client.ts`: `createHubClient({ hubUrl, token, fetch, WebSocket })`, the typed tRPC client with the same split link as before (`httpBatchLink` for queries and mutations, `wsLink` for subscriptions).
- `transcript.ts`: the pure chat transcript reducer.
- `sse.ts` and `chat-stream.ts`: an SSE reader over a streaming `Response`, reconnect with backoff, resume from the last event id and log revision, and the history load. `useChatSubscription` in `apps/web` is a thin React wrapper over it.
- `client-state.ts`: the client-state store with a pluggable storage backend. `createCachedStorage` wraps an async backend such as AsyncStorage in the synchronous interface the store reads.
- `center-tabs.ts`: parsing, key names and the merge rules ("a device keeps the entries it doesn't show"). Code that touches the dockview stays in `apps/web`.

The dashboard store and adapter in `apps/web/src/dashboard/` stay where they are until the mobile app needs them.

## Consequences

- A change to the chat event format, the reconnect rules or the shared-tab rules is made once and tested in `packages/client`.
- Another client to keep working against the hub API. The hub's tRPC `AppRouter` type is the contract, and `band-subscribe` and push replace polling on the phone.
- The web UI now reads the chat stream with `fetch` in every case, where it used a native `EventSource` when the hub was same-origin. Resume and gap-fill use the same query parameters as before.
