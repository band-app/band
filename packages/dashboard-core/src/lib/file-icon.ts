import { createElement, type FC } from "react";
import { resolveFolderIconName, resolveIconName, resolveIconPath } from "./file-icon-resolve";

// All material-icon-theme SVGs inlined as raw strings, then assembled into a
// single hidden <svg> sprite parsed via DOMParser and appended to <body>.
// Components render via <use href="#mit-{basename}"> — synchronous, no network
// roundtrip, no flicker. SVG sources originate from the bundled npm package
// at build time, not from user input.
//
// Glob path is relative to this file (src/lib/), so it resolves to
// packages/dashboard-core/node_modules/material-icon-theme/icons/*.svg. pnpm
// places a package-local symlink there; if hoisting config ever changes the
// glob matches zero files — caught by the non-empty assertion below rather
// than silently shipping blank icons.
//
// SSR-gated via `typeof window === "undefined"` rather than Vite's
// `import.meta.env.SSR`, because this module is bundled by two different
// toolchains:
//
//   1. Vite — builds the client and SSR bundles for apps/web. Vite's
//      `--platform=browser`/`--platform=node` esbuild minifier folds
//      `typeof window` to a literal, so the dead branch (sprite injection
//      in SSR, `{}` placeholder in client) is dead-code-eliminated and the
//      ~1.2k inlined SVG strings stay out of the SSR bundle.
//   2. esbuild (apps/web/scripts/build-server.sh) — bundles
//      `apps/web/start-server.ts` into `dist/start-server.mjs`. esbuild
//      does NOT define `import.meta.env`, so `import.meta.env.SSR` throws
//      `TypeError: Cannot read properties of undefined (reading 'SSR')` at
//      runtime. Switching to `typeof window` keeps esbuild's
//      `--platform=node` constant-fold path working and makes this module
//      safe under any bundler that knows the target platform.
//
// `IS_SSR` is intentionally a `const` initialised from a `typeof` literal
// so both Vite's and esbuild's tree-shakers can constant-fold it without
// extra hints.
const IS_SSR = typeof window === "undefined";

const iconSources: Record<string, string> = IS_SSR
  ? {}
  : import.meta.glob<string>("../../node_modules/material-icon-theme/icons/*.svg", {
      query: "?raw",
      import: "default",
      eager: true,
    });

if (!IS_SSR && Object.keys(iconSources).length === 0) {
  throw new Error(
    "[dashboard-core/file-icon] material-icon-theme SVG glob matched zero files. " +
      "Check packages/dashboard-core/node_modules/material-icon-theme/icons.",
  );
}

const SYMBOL_PREFIX = "mit-";
const SPRITE_ID = "mit-icon-sprite";

const symbolByBasename: Record<string, string> = {};
for (const path of Object.keys(iconSources)) {
  const file = path.split("/").pop();
  if (file) symbolByBasename[file] = `${SYMBOL_PREFIX}${file.replace(/\.svg$/, "")}`;
}

function buildSpriteMarkup(): string {
  const parts: string[] = [
    // xmlns:xlink is required: a handful of source icons (aurelia,
    // folder-css, folder-cloud-functions, …) use xlink:href internally.
    // buildSpriteMarkup strips each icon's own <svg> wrapper (which carried
    // the declaration), so without it here the strict image/svg+xml parse
    // hits an undefined-prefix error and the ENTIRE sprite is discarded.
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="position:absolute;width:0;height:0" aria-hidden="true">',
  ];
  for (const [path, src] of Object.entries(iconSources)) {
    const file = path.split("/").pop();
    if (!file) continue;
    const viewBox = src.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 32 32";
    const inner = src.match(/<svg[^>]*>([\s\S]*?)<\/svg>\s*$/)?.[1];
    if (!inner) continue;
    parts.push(`<symbol id="${symbolByBasename[file]}" viewBox="${viewBox}">${inner}</symbol>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

let spriteInjected = false;
let spriteMarkupCache: string | null = null;
function ensureSprite(): void {
  if (spriteInjected) return;
  if (typeof document === "undefined" || typeof DOMParser === "undefined") return;
  if (document.getElementById(SPRITE_ID)) {
    spriteInjected = true;
    return;
  }
  // Body may not be parsed yet when the module-init call runs (script in
  // <head> without defer). Bail; the per-render ensureSprite() retries once
  // the body exists. Memoize the markup so that retry path doesn't re-run
  // the ~1.2k-SVG regex/join on every render until then.
  if (!document.body) return;
  if (spriteMarkupCache === null) spriteMarkupCache = buildSpriteMarkup();
  const parsed = new DOMParser().parseFromString(spriteMarkupCache, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.nodeName === "parsererror") {
    console.error(
      "[dashboard-core/file-icon] Failed to parse SVG sprite markup. Icons will render blank.",
    );
    return;
  }
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
