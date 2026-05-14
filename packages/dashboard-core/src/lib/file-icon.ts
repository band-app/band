import { createElement, type FC } from "react";
import { resolveFolderIconName, resolveIconName, resolveIconPath } from "./file-icon-resolve";

// All material-icon-theme SVGs inlined as raw strings, then assembled into a
// single hidden <svg> sprite parsed via DOMParser and appended to <body>.
// Components render via <use href="#mit-{basename}"> — synchronous, no network
// roundtrip, no flicker. SVG sources originate from the bundled npm package
// at build time, not from user input.
const iconSources = import.meta.glob<string>("../../node_modules/material-icon-theme/icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

const SYMBOL_PREFIX = "mit-";
const SPRITE_ID = "mit-icon-sprite";

const symbolByBasename: Record<string, string> = {};
for (const path of Object.keys(iconSources)) {
  const file = path.split("/").pop();
  if (file) symbolByBasename[file] = `${SYMBOL_PREFIX}${file.replace(/\.svg$/, "")}`;
}

function buildSpriteMarkup(): string {
  const parts: string[] = [
    '<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0" aria-hidden="true">',
  ];
  for (const [path, src] of Object.entries(iconSources)) {
    const file = path.split("/").pop();
    if (!file) continue;
    const viewBox = src.match(/\sviewBox="([^"]+)"/)?.[1] ?? "0 0 32 32";
    const inner = src.match(/<svg[^>]*>([\s\S]*)<\/svg>\s*$/)?.[1];
    if (!inner) continue;
    parts.push(`<symbol id="${symbolByBasename[file]}" viewBox="${viewBox}">${inner}</symbol>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

let spriteInjected = false;
function ensureSprite(): void {
  if (spriteInjected) return;
  if (typeof document === "undefined" || typeof DOMParser === "undefined") return;
  if (document.getElementById(SPRITE_ID)) {
    spriteInjected = true;
    return;
  }
  const parsed = new DOMParser().parseFromString(buildSpriteMarkup(), "image/svg+xml");
  const root = parsed.documentElement;
  if (root.nodeName === "parsererror") return;
  root.id = SPRITE_ID;
  document.body.appendChild(root);
  spriteInjected = true;
}

// Inject at module init so the sprite is in the DOM before the first React
// commit references any <use href>.
ensureSprite();

function symbolIdForIcon(iconName: string): string | null {
  const iconPath = resolveIconPath(iconName);
  if (!iconPath) return null;
  const file = iconPath.split("/").pop();
  if (!file) return null;
  return symbolByBasename[file] ?? null;
}

type IconProps = { className?: string };
type IconComponent = FC<IconProps>;

const componentByKey = new Map<string, IconComponent>();

function makeComponent(iconName: string, displayPrefix: string): IconComponent {
  const symbolId = symbolIdForIcon(iconName);
  const Component: IconComponent = ({ className }) => {
    // Defensive: idempotent. Covers post-hydration first-paint where module
    // top-level ran before document was ready.
    ensureSprite();
    if (!symbolId) {
      return createElement("svg", {
        width: 16,
        height: 16,
        "aria-hidden": true,
        className,
      });
    }
    return createElement(
      "svg",
      {
        width: 16,
        height: 16,
        "aria-hidden": true,
        className,
      },
      createElement("use", { href: `#${symbolId}` }),
    );
  };
  Component.displayName = `${displayPrefix}(${iconName})`;
  return Component;
}

function getOrCreate(iconName: string, displayPrefix: string): IconComponent {
  const key = `${displayPrefix}:${iconName}`;
  const cached = componentByKey.get(key);
  if (cached) return cached;
  const comp = makeComponent(iconName, displayPrefix);
  componentByKey.set(key, comp);
  return comp;
}

/**
 * Returns a React component that renders a Material Icon Theme SVG for the given filename.
 * Drop-in replacement for the previous lucide-react based icon resolver.
 */
export function getFileIcon(filename: string): IconComponent {
  return getOrCreate(resolveIconName(filename), "FileIcon");
}

/**
 * Returns a React component that renders a Material Icon Theme SVG for a folder.
 * Use `expanded: true` for the open-folder variant.
 */
export function getFolderIcon(name: string, expanded = false): IconComponent {
  return getOrCreate(resolveFolderIconName(name, expanded), "FolderIcon");
}
