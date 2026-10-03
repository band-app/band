// Runs `vite build` and exits when it finishes.
//
// SPA mode prerenders the shell by loading the server bundle in-process. That
// bundle holds the whole tRPC router, whose module-level timers and handles
// keep the event loop alive, so the stock `vite build` CLI never returns.
import { createBuilder } from "vite";

const builder = await createBuilder();
await builder.buildApp();
process.exit(0);
