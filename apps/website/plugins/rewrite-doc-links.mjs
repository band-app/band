// Rehype plugin: the guides in docs/ link to each other and to code as relative
// `.md` and repo paths, which work on GitHub. On the site a link to another guide
// becomes /docs/<slug>, and a link to anything else in the repo becomes a GitHub URL.
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// A guide is a public page when its frontmatter has `section`.
function isPublic(target) {
  const file = posix.join(repoRoot, target);
  return existsSync(file) && /^---\n[\s\S]*?\nsection:/.test(readFileSync(file, "utf8"));
}

const REPO = "https://github.com/band-app/band/blob/main";

function walk(node, fn) {
  fn(node);
  for (const child of node.children ?? []) walk(child, fn);
}

export default function rewriteDocLinks() {
  return (tree, file) => {
    const rel = file.history?.[0]?.split("/docs/").pop() ?? "";
    const dir = posix.dirname(`docs/${rel}`);
    walk(tree, (node) => {
      if (node.type !== "element" || node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string" || /^([a-z]+:|#|\/)/i.test(href)) return;
      const [path, hash] = href.split("#");
      const target = posix.normalize(posix.join(dir, path));
      const hashPart = hash ? `#${hash}` : "";
      const guide = /^docs\/([^/]+)\.md$/.exec(target);
      node.properties.href = guide && isPublic(target)
        ? `/docs/${guide[1]}${hashPart}`
        : `${REPO}/${target}${hashPart}`;
    });
  };
}
