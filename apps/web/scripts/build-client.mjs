// Runs `vite build` and exits when it finishes.
//
// SPA mode prerenders the shell by loading the server bundle in-process. That
// bundle holds the whole tRPC router, whose module-level timers and handles
// keep the event loop alive, so the stock `vite build` CLI never returns.
//
// The prerender step logs a failed crawl and still returns, so a build with no
// shell looks successful. Check for the file and fail the build instead.
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createBuilder } from "vite";

const shell = resolve(import.meta.dirname, "../dist/client/_shell.html");
// A shell left by an earlier build would hide a prerender that wrote nothing.
rmSync(shell, { force: true });

const builder = await createBuilder();
await builder.buildApp();

if (!existsSync(shell)) {
  console.error(
    `Build failed: ${shell} was not written. The SPA shell prerender produced no pages, ` +
      "so the server would crash at start. Look for a [prerender] error above.",
  );
  process.exit(1);
}
process.exit(0);
