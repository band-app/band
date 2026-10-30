import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import rewriteDocLinks from "./plugins/rewrite-doc-links.mjs";

// Old /docs/<slug> URLs whose page moved or was renamed.
const redirects = {
  "/docs/installation": "/docs/install",
  "/docs/flexible-layout": "/docs/layout",
  "/docs/changes-view": "/docs/changes",
};

export default defineConfig({
  site: "https://getband.app",
  redirects,
  markdown: { rehypePlugins: [rewriteDocLinks] },
  vite: {
    plugins: [tailwindcss()],
  },
});
