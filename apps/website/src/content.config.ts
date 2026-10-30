import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const page = z.object({
  title: z.string(),
  description: z.string(),
  section: z.string(),
  order: z.number(),
  // Shorter label for the sidebar.
  navLabel: z.string().optional(),
});

// Guides: `docs/*.md` at the repo root. A file is a public page only when its
// frontmatter has a `section`; the loader skips every other file.
const guides = defineCollection({
  loader: glob({ pattern: "*.md", base: "../../docs" }),
  schema: z.object({}).passthrough(),
});

// CLI reference pages: prose here, flag tables from `src/data/cli-schema.json`.
const cli = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/cli" }),
  schema: page.extend({
    // Top-level `band` commands this page documents.
    commands: z.array(z.string()),
  }),
});

export const collections = { guides, cli };
export { page };
