import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";
import type { AppRouter } from "../trpc/router";

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
      // Keep this in sync with the `WebDashboardAdapter` client in
      // `packages/dashboard-core/src/adapters/web.ts` — both fan out
      // batched GETs and both need the same cap to stay under any
      // browser / proxy / Node `--max-http-header-size` (issue #430).
      false: httpBatchLink({ url: "/trpc", maxURLLength: 2000 }),
    }),
  ],
});
