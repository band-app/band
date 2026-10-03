import type { AppRouter } from "@band-app/server";
import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";

import { HubWebSocket, hubFetch, hubUrl, hubWsUrl } from "./hub-config";

const wsClient = createWSClient({
  url: () => {
    return hubWsUrl("/trpc");
  },
  WebSocket: HubWebSocket,
});

export const trpc = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition: (op) => op.type === "subscription",
      true: wsLink({ client: wsClient }),
      // Keep maxURLLength in sync with WebDashboardAdapter (apps/web/src/dashboard/adapters/web.ts) — issue #430.
      false: httpBatchLink({
        url: hubUrl("/trpc"),
        maxURLLength: 2000,
        fetch: (url, init) => hubFetch(String(url), init),
      }),
    }),
  ],
});
