import { resolve } from "node:path";
import { createLogger } from "@band/logger";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { WebSocketServer } from "ws";

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

      // WebSocket server for tRPC subscriptions (no auth in dev mode)
      const wss = new WebSocketServer({ noServer: true });
      const terminalWss = new WebSocketServer({ noServer: true });
      let wssHandlerInitialized = false;

      server.httpServer?.on("upgrade", async (req, socket, head) => {
        // Let Vite handle its own HMR WebSocket upgrades
        if (req.headers["sec-websocket-protocol"]?.includes("vite-hmr")) return;

        const url = new URL(req.url!, `http://${req.headers.host}`);

        // Terminal WebSocket
        if (url.pathname === "/terminal") {
          try {
            const { handleTerminalConnection } = await server.ssrLoadModule(
              "./src/lib/terminal-ws",
            );
            terminalWss.handleUpgrade(req, socket, head, (ws: any) => {
              handleTerminalConnection(ws, req).catch((err: Error) => {
                log.error("Terminal connection error: %s", err.message);
              });
            });
          } catch (err) {
            log.error("Failed to load terminal module: %s", err);
            socket.destroy();
          }
          return;
        }

        // tRPC WebSocket
        if (!wssHandlerInitialized) {
          const [{ applyWSSHandler }, { createContext }, { appRouter }] = (await Promise.all([
            server.ssrLoadModule("@trpc/server/adapters/ws"),
            server.ssrLoadModule("./src/trpc/context"),
            server.ssrLoadModule("./src/trpc/router"),
            // biome-ignore lint/suspicious/noExplicitAny: ssrLoadModule returns untyped modules
          ])) as [any, any, any];
          applyWSSHandler({ wss, router: appRouter, createContext });
          wssHandlerInitialized = true;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
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

      // Clean up tunnel, terminals, and WebSocket servers on dev server shutdown
      server.httpServer?.on("close", () => {
        wss.close();
        terminalWss.close();
        server.ssrLoadModule("./src/lib/terminal-manager").then(({ killAllTerminals }) => {
          killAllTerminals();
        });
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
          // node-pty is a native addon that cannot be bundled
          external: ["node-pty"],
        }
      : {
          // node-pty is a native addon that cannot be bundled
          external: ["node-pty"],
        },
}));
