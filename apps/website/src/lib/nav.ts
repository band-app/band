import { getCollection } from "astro:content";
import { page } from "../content.config";

export const SECTIONS: { id: string; title: string }[] = [
  { id: "get-started", title: "Get started" },
  { id: "using-band", title: "Using Band" },
  { id: "agents", title: "Coding agents" },
  { id: "workers", title: "Workers and self-hosting" },
  { id: "access", title: "Access and security" },
  { id: "automation", title: "Automation" },
  { id: "mobile", title: "Mobile" },
  { id: "configuration", title: "Configuration" },
  { id: "cli", title: "CLI reference" },
  { id: "more", title: "More" },
];

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  section: string;
  order: number;
  kind: "guide" | "cli";
}

/** Every public docs page: guides with a `section`, plus the CLI pages. */
export async function allPages(): Promise<DocPage[]> {
  const out: DocPage[] = [];
  for (const entry of await getCollection("guides")) {
    const parsed = page.safeParse(entry.data);
    if (!parsed.success) continue;
    out.push({ slug: entry.id, kind: "guide", ...parsed.data });
  }
  for (const entry of await getCollection("cli")) {
    out.push({ slug: entry.id, kind: "cli", ...entry.data });
  }
  return out;
}

export async function navSections() {
  const pages = await allPages();
  return SECTIONS.map((s) => ({
    title: s.title,
    links: pages
      .filter((p) => p.section === s.id)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
      .map((p) => ({ href: `/docs/${p.slug}`, label: p.navLabel ?? p.title })),
  })).filter((s) => s.links.length > 0);
}
