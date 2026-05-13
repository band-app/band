import iconManifest from "material-icon-theme/dist/material-icons.json";
import { createElement, type FC } from "react";

interface IconManifest {
  iconDefinitions: Record<string, { iconPath: string }>;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  languageIds: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
}

const manifest = iconManifest as unknown as IconManifest;

// Bundle every material-icon-theme SVG as a static asset URL.
// Path is relative to this file; Vite expands it at build time and emits
// each SVG as a hashed asset. The output map is keyed by source path,
// and we look up icons via the basename.
const iconUrlByPath = import.meta.glob<string>(
  "../../node_modules/material-icon-theme/icons/*.svg",
  {
    eager: true,
    query: "?url",
    import: "default",
  },
);

const urlByBasename: Record<string, string> = {};
for (const [path, url] of Object.entries(iconUrlByPath)) {
  const file = path.split("/").pop();
  if (file) urlByBasename[file] = url;
}

function iconPathToUrl(iconPath: string): string | null {
  const file = iconPath.split("/").pop();
  if (!file) return null;
  return urlByBasename[file] ?? null;
}

function resolveIconName(filename: string): string {
  const basename = (filename.split("/").pop() ?? filename).toLowerCase();

  // Exact filename match (e.g. Dockerfile, pubspec.yaml)
  const byName = manifest.fileNames[basename];
  if (byName) return byName;

  // Compound extensions: try longest first (e.g. "stories.tsx" before "tsx")
  const segments = basename.split(".");
  for (let i = 1; i < segments.length; i++) {
    const ext = segments.slice(i).join(".");
    const byExt = manifest.fileExtensions[ext];
    if (byExt) return byExt;
  }

  return manifest.file;
}

type IconProps = { className?: string };
type IconComponent = FC<IconProps>;

const componentCache = new Map<string, IconComponent>();

function makeIconComponent(filename: string): IconComponent {
  const iconName = resolveIconName(filename);
  const def = manifest.iconDefinitions[iconName] ?? manifest.iconDefinitions[manifest.file];
  const url = def ? iconPathToUrl(def.iconPath) : null;

  const Component: IconComponent = ({ className }) =>
    createElement("img", {
      src: url ?? "",
      alt: "",
      "aria-hidden": true,
      className,
      draggable: false,
    });
  Component.displayName = `FileIcon(${iconName})`;
  return Component;
}

/**
 * Returns a React component that renders a Material Icon Theme SVG for the given filename.
 * Drop-in replacement for the previous lucide-react based icon resolver.
 */
export function getFileIcon(filename: string): IconComponent {
  const key = (filename.split("/").pop() ?? filename).toLowerCase();
  const cached = componentCache.get(key);
  if (cached) return cached;
  const comp = makeIconComponent(filename);
  componentCache.set(key, comp);
  return comp;
}

function resolveFolderIconName(name: string, expanded: boolean): string {
  const basename = (name.split("/").pop() ?? name).toLowerCase();
  const map = expanded ? manifest.folderNamesExpanded : manifest.folderNames;
  const named = map[basename];
  if (named) return named;
  return expanded ? manifest.folderExpanded : manifest.folder;
}

const folderCache = new Map<string, IconComponent>();

function makeFolderComponent(name: string, expanded: boolean): IconComponent {
  const iconName = resolveFolderIconName(name, expanded);
  const def = manifest.iconDefinitions[iconName];
  const url = def ? iconPathToUrl(def.iconPath) : null;

  const Component: IconComponent = ({ className }) =>
    createElement("img", {
      src: url ?? "",
      alt: "",
      "aria-hidden": true,
      className,
      draggable: false,
    });
  Component.displayName = `FolderIcon(${iconName})`;
  return Component;
}

/**
 * Returns a React component that renders a Material Icon Theme SVG for a folder.
 * Use `expanded: true` for the open-folder variant.
 */
export function getFolderIcon(name: string, expanded = false): IconComponent {
  const key = `${expanded ? "1" : "0"}:${(name.split("/").pop() ?? name).toLowerCase()}`;
  const cached = folderCache.get(key);
  if (cached) return cached;
  const comp = makeFolderComponent(name, expanded);
  folderCache.set(key, comp);
  return comp;
}
