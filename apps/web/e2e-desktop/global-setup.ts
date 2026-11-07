import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRealProfile, realProfileDir } from "./helpers/profile-guard";
import { listBandDevices } from "./helpers/simulator-guard";

/** Where the before-run listing of the real Band profile is kept for `global-teardown.ts`. */
export const SNAPSHOT_FILE = join(tmpdir(), `band-desktop-e2e-real-profile-${process.ppid}.json`);

// Read-only: lists the real profile and writes the listing to the OS temp dir.
export default function globalSetup(): void {
  const listing = listRealProfile();
  writeFileSync(
    SNAPSHOT_FILE,
    JSON.stringify({
      dir: realProfileDir(),
      entries: [...listing.entries()],
      // null when xcrun is missing: the teardown then skips the device check.
      bandDevices: listBandDevices(),
    }),
  );
}
