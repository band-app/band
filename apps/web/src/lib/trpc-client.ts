import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";
import type { AppRouter } from "../server/api/router";

const wsClient = createWSClient({
  url: () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/trpc`;
  },
});

export const trpc = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition: (op) => op.type === "subscription",
      true: wsLink({ client: wsClient }),
      // Keep maxURLLength in sync with WebDashboardAdapter (apps/web/src/dashboard/adapters/web.ts) — issue #430.
      false: httpBatchLink({ url: "/trpc", maxURLLength: 2000 }),
    }),
  ],
});
