import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// ---------------------------------------------------------------------------
// Vite config.
//
// As of #477 there is **no dev plugin here** — the legacy `trpcDevPlugin`
// (~370 lines) that used to re-implement `/trpc`, `/mcp`, `/api/*` and the
// WebSocket upgrade routing on top of Vite's middleware chain has been
// deleted. The unified `start-server.ts` now owns the http server in both
// dev and prod; in dev it mounts Vite as middleware *inside* itself via
// `createServer({ server: { middlewareMode: true } })`. That makes this
// config a true single-source-of-truth for the renderer build pipeline,
// shared by `tsx watch start-server.ts` (dev) and `vite build` (prod).
//
// Anything that used to live in `trpcDevPlugin` — auth-less /trpc, file
// serving, terminal/LSP/CDP/tRPC WebSocket upgrades, tunnel auto-start,
// first-time-setup, etc. — now runs in `start-server.ts` in both modes.
// Dev-vs-prod drift is structurally impossible.
// ---------------------------------------------------------------------------

function readBuildInfo() {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as {
    version: string;
  };
  let sha = process.env.BAND_BUILD_SHA ?? "";
  if (!sha) {
    try {
      sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: import.meta.dirname,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      sha = "dev";
    }
  }
  const channel = process.env.BAND_BUILD_CHANNEL ?? "dev";
  return {
    version: pkg.version,
    sha,
    date: new Date().toISOString(),
    channel,
  };
}

const buildInfo = readBuildInfo();

export default defineConfig(({ command }) => ({
  server: {
    allowedHosts: [".trycloudflare.com"],
  },
  define: {
    __BAND_VERSION__: JSON.stringify(buildInfo.version),
    __BAND_BUILD_SHA__: JSON.stringify(buildInfo.sha),
    __BAND_BUILD_DATE__: JSON.stringify(buildInfo.date),
    __BAND_BUILD_CHANNEL__: JSON.stringify(buildInfo.channel),
  },
  plugins: [tanstackStart(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
      // langium (transitive dep via mermaid) imports deep paths from
      // vscode-jsonrpc, but under pnpm strict node_modules the package
      // isn't reachable from langium's physical location. Point the bare
      // specifier at the installed copy so both Vite dev and Rollup build
      // can resolve it.
      "vscode-jsonrpc": resolve(import.meta.dirname, "node_modules/vscode-jsonrpc"),
    },
  },
  ssr:
    command === "build"
      ? {
          // Bundle all dependencies into server.js so the Electron DMG
          // doesn't need node_modules at runtime.
          noExternal: true,
          // node-pty is a native addon that cannot be bundled
          external: ["node-pty"],
        }
      : {
          // node-pty is a native addon that cannot be bundled
          external: ["node-pty"],
        },
}));
