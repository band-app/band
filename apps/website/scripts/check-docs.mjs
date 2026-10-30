// Checks the docs site. `node scripts/check-docs.mjs source` scans the page sources
// for phrases that must not come back. `node scripts/check-docs.mjs dist` checks the
// built site: every internal link and image resolves, every #anchor exists, and every
// old /docs/<slug> URL still answers. `build` runs both.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const repo = resolve(site, "../..");
const mode = process.argv[2] ?? "all";
const errors = [];

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

// URLs that worked before the docs moved to markdown.
const OLD_SLUGS = [
  "agent-status", "architecture", "changes-view", "claude-code", "cli-browsers", "cli-chats",
  "cli-cronjobs", "cli-reference", "cli-repos", "cli-settings", "cli-terminals", "cli-tunnel",
  "cli-worktrees", "codex", "coding-agents", "configuration", "cronjobs", "first-repo",
  "first-task", "first-worktree", "flexible-layout", "getting-started", "installation",
  "opencode", "recipes", "remote-access", "repos", "settings", "worktrees",
];

// A docs page is public when its frontmatter has `section`.
function publicGuides() {
  const dir = join(repo, "docs");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f))
    .filter((f) => /^---\n[\s\S]*?\nsection:/.test(readFileSync(f, "utf8")));
}

function checkSource() {
  const files = [
    ...publicGuides(),
    ...walk(join(site, "src/content/cli"), [".md"]),
    ...walk(join(site, "src/pages"), [".astro"]),
  ];
  const banned = [
    [/worktree['’]s worktree/i, "garbled rename: worktree's worktree"],
    [/its worktree\b.*\bworktree and its worktree/i, "garbled rename"],
    [/(?<!other )\b(three|3) (coding )?agents\b/i, "Band supports five agents"],
    [/\bon any host\b|\bper host\b/i, "say worker, not host"],
    [/(?<!no )\bIntel\b/, "the desktop app is Apple Silicon only"],
    [/repos add[^\n]*--label/, "repos add has no --label flag"],
    [/text-delta/, "chat events are ACP updates, not text-delta"],
    [/\bws_abc123\b/, "worktree ids are <repo>-<branch>"],
    [/executablePath/, "agents use `command`, not executablePath"],
    [/claude-agent-sdk|codex-sdk/, "agents run over ACP, not these SDKs"],
    [/hamburger/i, "there is no hamburger menu"],
    [/About[^\n]*Install CLI/i, "the CLI installs from the banner or Homebrew, not an About page"],
    [/named tunnel/i, "there is no named tunnel setting"],
    [/(BAND_SERVER_URL|default)[^\n]*localhost:3456/, "BAND_SERVER_URL defaults to 127.0.0.1:<webServerPort>"],
  ];
  const noDash = [[/—|&mdash;/, "no em dashes in docs prose"]];
  for (const f of files) {
    const text = readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const rules = f.endsWith(".md") ? [...banned, ...noDash] : banned;
    text.split("\n").forEach((line, i) => {
      for (const [re, why] of rules) {
        if (re.test(line)) errors.push(`${relative(repo, f)}:${i + 1}: ${why}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
}

function checkDist() {
  const dist = join(site, "dist");
  if (!existsSync(dist)) {
    errors.push("dist/ is missing. Run the build first.");
    return;
  }
  const resolveUrl = (path) => {
    const rel = path.replace(/^\//, "");
    for (const c of [rel, join(rel, "index.html"), `${rel}.html`]) {
      const full = join(dist, c);
      if (existsSync(full) && statSync(full).isFile()) return full;
    }
    return null;
  };
  const idsCache = new Map();
  const idsOf = (file) => {
    if (!idsCache.has(file)) {
      const html = readFileSync(file, "utf8");
      idsCache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
    }
    return idsCache.get(file);
  };
  for (const file of walk(dist, [".html"])) {
    const html = readFileSync(file, "utf8");
    const pageUrl = "/" + relative(dist, file).replace(/index\.html$/, "").replace(/\.html$/, "");
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const url = m[1];
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;
      const [rawPath, hash] = url.split("#");
      const path = rawPath === "" ? pageUrl : rawPath.startsWith("/") ? rawPath : null;
      if (path === null) {
        errors.push(`${pageUrl}: relative link ${url}`);
        continue;
      }
      const target = resolveUrl(path.split("?")[0]);
      if (!target) {
        errors.push(`${pageUrl}: broken link ${url}`);
      } else if (hash && target.endsWith(".html") && !idsOf(target).has(decodeURIComponent(hash))) {
        errors.push(`${pageUrl}: missing anchor ${url}`);
      }
    }
  }
  for (const slug of OLD_SLUGS) {
    if (!resolveUrl(`/docs/${slug}`)) errors.push(`old URL /docs/${slug} no longer resolves`);
  }
}

if (mode === "source" || mode === "all") checkSource();
if (mode === "dist" || mode === "all") checkDist();

if (errors.length) {
  console.error(`${errors.length} docs problem(s):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`docs check (${mode}) passed`);
