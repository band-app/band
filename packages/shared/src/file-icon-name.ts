/**
 * Which file-type icon a file or folder gets, as a name in material-icon-theme's manifest. The web
 * calls these with the full manifest and the mobile app with the subset it ships, so both resolve a
 * name the same way and differ only in which icons exist.
 */

export interface FileIconMaps {
  fileNames: Readonly<Record<string, string>>;
  fileExtensions: Readonly<Record<string, string>>;
  folderNames: Readonly<Record<string, string>>;
  folderNamesExpanded: Readonly<Record<string, string>>;
  /** The icon of a file with no match. */
  file: string;
  folder: string;
  folderExpanded: string;
}

function lookup(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function resolveFileIconName(maps: FileIconMaps, filename: string): string {
  const basename = (filename.split("/").pop() ?? filename).toLowerCase();

  // Exact filename match (e.g. Dockerfile, pubspec.yaml)
  const byName = lookup(maps.fileNames, basename);
  if (byName) return byName;

  // Compound extensions: try longest first (e.g. "stories.tsx" before "tsx")
  const segments = basename.split(".");
  for (let i = 1; i < segments.length; i++) {
    const byExt = lookup(maps.fileExtensions, segments.slice(i).join("."));
    if (byExt) return byExt;
  }

  return maps.file;
}

export function resolveFolderIconName(maps: FileIconMaps, name: string, expanded: boolean): string {
  const basename = (name.split("/").pop() ?? name).toLowerCase();
  const named = lookup(expanded ? maps.folderNamesExpanded : maps.folderNames, basename);
  if (named) return named;
  return expanded ? maps.folderExpanded : maps.folder;
}
