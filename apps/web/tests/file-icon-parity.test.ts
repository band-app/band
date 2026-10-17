import {
  resolveFileIconName,
  resolveFolderIconName as resolveShared,
} from "@band-app/shared/file-icon-name";
import { describe, expect, it } from "vite-plus/test";

import { FILE_ICON_MAPS } from "../../mobile/src/lib/files/file-icons.generated.ts";
import { resolveFolderIconName, resolveIconName } from "../src/dashboard/lib/file-icon-resolve.ts";

// The phone ships a subset of the web's icons through the same shared resolver. For every name
// in the subset, the phone must pick the icon the web picks.
const files = [
  ...Object.keys(FILE_ICON_MAPS.fileNames),
  ...Object.keys(FILE_ICON_MAPS.fileExtensions).map((ext) => `a.${ext}`),
  "src/deep/tsconfig.json",
  "a.test.tsx",
  "a.stories.tsx",
  "a.d.ts",
  "a.zzz",
];
const folders = [
  ...Object.keys(FILE_ICON_MAPS.folderNames),
  ...Object.keys(FILE_ICON_MAPS.folderNamesExpanded),
  "zzz-unknown",
];

describe("file icon parity with the mobile app", () => {
  it("resolves files like the web", () => {
    for (const name of files) {
      const web = resolveIconName(name);
      const phone = resolveFileIconName(FILE_ICON_MAPS, name);
      expect(phone, name).toBe(web);
    }
  });

  it("resolves folders like the web, open and closed", () => {
    for (const name of folders) {
      for (const open of [false, true]) {
        expect(resolveShared(FILE_ICON_MAPS, name, open), `${name} ${open}`).toBe(
          resolveFolderIconName(name, open),
        );
      }
    }
  });
});
