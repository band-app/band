import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // In SPA mode a cold load holds the page's route in a pending state for
    // `defaultPendingMinMs` (500 ms). The route renders nothing, but its
    // effects (active worktree in the store) wait for it, so ⌘1..9 pressed
    // right after load saw no active worktree.
    defaultPendingMinMs: 0,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
