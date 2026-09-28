import iconManifest from "material-icon-theme/dist/material-icons.json" with { type: "json" };

export interface IconManifest {
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

export const manifest = iconManifest as unknown as IconManifest;

export function resolveIconName(filename: string): string {
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

export function resolveFolderIconName(name: string, expanded: boolean): string {
  const basename = (name.split("/").pop() ?? name).toLowerCase();
  const map = expanded ? manifest.folderNamesExpanded : manifest.folderNames;
  const named = map[basename];
  if (named) return named;
  return expanded ? manifest.folderExpanded : manifest.folder;
}

export function resolveIconPath(iconName: string): string | null {
  const def = manifest.iconDefinitions[iconName] ?? manifest.iconDefinitions[manifest.file];
  if (!def?.iconPath) {
    console.error(
      `[dashboard/file-icon] Missing iconDefinitions entry for "${iconName}" and fallback "${manifest.file}".`,
    );
    return null;
  }
  return def.iconPath;
}
