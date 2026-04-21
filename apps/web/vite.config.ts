import { createReadStream, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createLogger } from "@band-app/logger";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { generateOpenAPIDocument } from "@trpc/openapi";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { WebSocketServer } from "ws";
import { mimeTypeFromFilename } from "./src/lib/mime-types.ts";
import { getScalarHtml } from "./src/trpc/openapi.ts";

const log = createLogger("vite-plugin");

function trpcDevPlugin(): Plugin {
  let cachedSpec: string | null = null;

  return {
    name: "trpc-dev-server",
    configureServer(server) {
      // Invalidate cached spec when router or related files change
      server.watcher.on("change", (file) => {
        if (file.includes("/trpc/") || file.endsWith("router.ts")) {
          cachedSpec = null;
        }
      });

      // Serve OpenAPI spec (generated via @trpc/openapi static analysis)
      server.middlewares.use("/api/openapi.json", async (_req, res) => {
        if (!cachedSpec) {
          const doc = await generateOpenAPIDocument("./src/trpc/router.ts", {
            title: "Band API",
            version: "1.0.0",
          });
          // Add server base path so Scalar shows correct URLs
          // biome-ignore lint/suspicious/noExplicitAny: extending generated OpenAPI doc
          (doc as any).servers = [{ url: "/trpc" }];
          cachedSpec = JSON.stringify(doc, null, 2);
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(cachedSpec);
      });

      // Serve Scalar API docs UI
      server.middlewares.use("/api/docs", async (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(getScalarHtml("/api/openapi.json"));
      });

      // Serve uploaded files
      server.middlewares.use("/api/uploads/", async (req, res) => {
        const { bandHome } = await server.ssrLoadModule("./src/lib/state");
        const rawPath = req.url ?? "";
        const filename = basename(decodeURIComponent(rawPath));
        if (!filename || filename.includes("..")) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const filePath = resolve(bandHome(), "uploads", filename);
        try {
          const fileStat = statSync(filePath);
          res.writeHead(200, {
            "Content-Type": mimeTypeFromFilename(filename),
            "Content-Length": fileStat.size.toString(),
            "Cache-Control": "private, max-age=86400",
          });
          createReadStream(filePath).pipe(res);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      // Serve agent-shared files — URL: /api/shared/<workspaceId>/<filename>
      server.middlewares.use("/api/shared/", async (req, res) => {
        const { bandHome } = await server.ssrLoadModule("./src/lib/state");
        const rest = (req.url ?? "").replace(/^\//, "");
        const slashIdx = rest.indexOf("/");
        if (slashIdx === -1) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const partition = basename(decodeURIComponent(rest.slice(0, slashIdx)));
        if (!partition || partition === ".." || partition === ".") {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const filename = basename(decodeURIComponent(rest.slice(slashIdx + 1)));
        if (!filename || filename.includes("..")) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const filePath = resolve(bandHome(), "shared", partition, filename);
        try {
          const fileStat = statSync(filePath);
          res.writeHead(200, {
            "Content-Type": mimeTypeFromFilename(filename),
            "Content-Length": fileStat.size.toString(),
            "Cache-Control": "private, max-age=86400",
          });
          createReadStream(filePath).pipe(res);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      // Serve workspace files (images, PDFs, etc.) — URL: /api/workspace-file/<workspaceId>/<path...>
      server.middlewares.use("/api/workspace-file/", async (req, res) => {
        const { resolveWorkspace } = await server.ssrLoadModule("./src/lib/workspace");
        const rest = (req.url ?? "").replace(/^\//, "");
        const slashIdx = rest.indexOf("/");
        if (slashIdx === -1) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const wId = decodeURIComponent(rest.slice(0, slashIdx));
        const filePath = rest.slice(slashIdx + 1);
        if (!wId || !filePath) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const workspace = resolveWorkspace(wId);
        if (!workspace) {
          res.writeHead(404);
          res.end("Workspace not found");
          return;
        }
        const root = workspace.worktree.path;
        const target = resolve(join(root, decodeURIComponent(filePath)));
        if (!target.startsWith(`${root}/`) && target !== root) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        try {
          const fileStat = statSync(target);
          res.writeHead(200, {
            "Content-Type": mimeTypeFromFilename(basename(target)),
            "Content-Length": fileStat.size.toString(),
            "Cache-Control": "private, no-cache",
          });
          createReadStream(target).pipe(res);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
      });

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

      // MCP (Model Context Protocol) endpoint (no auth in dev mode)
      server.middlewares.use("/mcp", async (req, res) => {
        const { handleMcpRequest } = await server.ssrLoadModule("./src/mcp/server");
        await handleMcpRequest(req, res);
      });

      // WebSocket server for tRPC subscriptions (no auth in dev mode)
      const wss = new WebSocketServer({ noServer: true });
      const terminalWss = new WebSocketServer({ noServer: true });
      const lspWss = new WebSocketServer({ noServer: true });
      let wssHandlerInitialized = false;

      server.httpServer?.on("upgrade", async (req, socket, head) => {
        // Let Vite handle its own HMR WebSocket upgrades
        if (req.headers["sec-websocket-protocol"]?.includes("vite-hmr")) return;

        const url = new URL(req.url!, `http://${req.headers.host}`);

        // LSP WebSocket
        if (url.pathname === "/lsp") {
          try {
            const { handleLspConnection } = await server.ssrLoadModule("./src/lib/lsp-proxy");
            // biome-ignore lint/suspicious/noExplicitAny: ssrLoadModule returns untyped modules
            lspWss.handleUpgrade(req, socket, head, (ws: any) => {
              handleLspConnection(ws, req).catch((err: Error) => {
                log.error("LSP connection error: %s", err.message);
              });
            });
          } catch (err) {
            log.error("Failed to load LSP module: %s", err);
            socket.destroy();
          }
          return;
        }

        // Terminal WebSocket
        if (url.pathname === "/terminal") {
          try {
            const { handleTerminalConnection } =
              await server.ssrLoadModule("./src/lib/terminal-ws");
            // biome-ignore lint/suspicious/noExplicitAny: ssrLoadModule returns untyped modules
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
        lspWss.close();
        server.ssrLoadModule("./src/lib/terminal-manager").then(({ killAllTerminals }) => {
          killAllTerminals();
        });
        server.ssrLoadModule("./src/lib/lsp-manager").then(({ killAllServers }) => {
          killAllServers();
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
