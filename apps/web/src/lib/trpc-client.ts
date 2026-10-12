import { createHubClient } from "@band-app/client/hub-client";
import { crossOriginHub, hubFetch, hubWsUrl } from "./hub-config";

// Same-origin, the page's cookie authenticates and `hubUrl` is empty (relative
// URLs); `hubFetch` keeps sending credentials. Cross-origin, the package adds
// the Bearer header and the WebSocket subprotocol from `token`.
const hub = crossOriginHub();

export const trpc = createHubClient({
  hubUrl: hub?.origin ?? "",
  token: hub?.token,
  fetch: (url, init) => hubFetch(String(url), init),
  wsUrl: () => hubWsUrl("/trpc"),
});
