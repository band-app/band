import { SvgXml } from "react-native-svg";

import { fileIconSvg, folderIconSvg } from "../lib/files/file-icon";

/** The file-type icon the web shows for a file name, in material-icon-theme's colors. */
export function FileIcon({ name, size = 18 }: { name: string; size?: number }) {
  return <SvgXml xml={fileIconSvg(name)} width={size} height={size} />;
}

export function FolderIcon({
  name,
  open,
  size = 18,
}: {
  name: string;
  open: boolean;
  size?: number;
}) {
  return <SvgXml xml={folderIconSvg(name, open)} width={size} height={size} />;
}
