import { resolve } from "node:path";
import { createLogger } from "@band/logger";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const log = createLogger("vite-plugin");

function trpcDevPlugin(): Plugin {
  return {
    name: "trpc-dev-server",
    configureServer(server) {
      server.middlewares.use("/trpc", async (req, res) => {
        // Use ssrLoadModule so Vite handles TS resolution at dev time
        const [{ nodeHTTPRequestHandler }, { createContext }, { appRouter }] = (await Promise.all([
          server.ssrLoadModule("@trpc/server/adapters/node-http"),
          server.ssrLoadModule("./src/trpc/context"),
          server.ssrLoadModule("./src/trpc/router"),
          // biome-ignore lint/suspicious/noExplicitAny: ssrLoadModule returns untyped modules
        ])) as [any, any, any];
        await nodeHTTPRequestHandler({
          router: appRouter,
          createContext,
          req,
          res,
          path: req.url?.split("?")[0]?.slice(1) ?? "",
          endpoint: "",
        });
      });

      // Auto-start tunnel if configured
      server.ssrLoadModule("./src/lib/state").then(async ({ loadSettings }) => {
        const settings = loadSettings() as Record<string, unknown>;
        if (!settings.autoStartTunnel) return;

        const { checkPrereqs } = await server.ssrLoadModule("./src/lib/process-utils");
        const prereqs = await checkPrereqs();
        if (!prereqs.cloudflared) return;

        const { startTunnel } = await server.ssrLoadModule("./src/lib/tunnel");
        const port = server.config.server.port ?? 3000;
        await startTunnel({ port }).catch((err: Error) => {
          log.error("Failed to auto-start tunnel: %s", err.message);
        });
      });

      // Clean up tunnel on dev server shutdown
      server.httpServer?.on("close", () => {
        server.ssrLoadModule("./src/lib/tunnel").then(({ stopTunnel }) => {
          stopTunnel().catch(() => {});
        });
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  server: {
    allowedHosts: [".trycloudflare.com"],
  },
  plugins: [trpcDevPlugin(), tanstackStart(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  ssr:
    command === "build"
      ? {
          // Bundle all dependencies into server.js so the Tauri DMG
          // doesn't need node_modules at runtime.
          noExternal: true,
        }
      : undefined,
}));
