import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://getband.app",
  vite: {
    plugins: [tailwindcss()],
  },
});
