import { resolveFileIconName, resolveFolderIconName } from "@band-app/shared/file-icon-name";

import { FILE_ICON_MAPS, FILE_ICON_SVG } from "./file-icons.generated.ts";

/** The SVG source of a file's icon, the web's pick for that name or the generic file icon. */
export function fileIconSvg(filename: string): string {
  const name = resolveFileIconName(FILE_ICON_MAPS, filename);
  return FILE_ICON_SVG[name] ?? FILE_ICON_SVG[FILE_ICON_MAPS.file] ?? "";
}

export function folderIconSvg(name: string, expanded: boolean): string {
  const icon = resolveFolderIconName(FILE_ICON_MAPS, name, expanded);
  const fallback = expanded ? FILE_ICON_MAPS.folderExpanded : FILE_ICON_MAPS.folder;
  return FILE_ICON_SVG[icon] ?? FILE_ICON_SVG[fallback] ?? "";
}
