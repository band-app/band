import type { AppRouter } from "@band-app/server";
import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";

import { directWorkerLink } from "./direct-worker";
import { HubWebSocket, hubFetch, hubUrl, hubWsUrl } from "./hub-config";

const wsClient = createWSClient({
  url: () => {
    return hubWsUrl("/trpc");
  },
  WebSocket: HubWebSocket,
});

export const trpc = createTRPCClient<AppRouter>({
  links: [
    // Files, diff and search of a worktree on this computer's worker skip the hub (desktop app only).
    directWorkerLink(),
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
