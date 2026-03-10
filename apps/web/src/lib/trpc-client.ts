import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../trpc/router";

export const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/trpc" })],
});
