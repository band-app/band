import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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
    },
  };
}

export default defineConfig({
  plugins: [trpcDevPlugin(), tanstackStart(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
});
