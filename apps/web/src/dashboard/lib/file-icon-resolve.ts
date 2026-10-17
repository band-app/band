import {
  resolveFileIconName,
  resolveFolderIconName as resolveSharedFolderIconName,
} from "@band-app/shared/file-icon-name";
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
  return resolveFileIconName(manifest, filename);
}

export function resolveFolderIconName(name: string, expanded: boolean): string {
  return resolveSharedFolderIconName(manifest, name, expanded);
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
