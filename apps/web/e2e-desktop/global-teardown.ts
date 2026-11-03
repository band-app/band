import { readFileSync, rmSync } from "node:fs";
import { SNAPSHOT_FILE } from "./global-setup";
import { diffListings, listRealProfile, type ProfileListing } from "./helpers/profile-guard";

// Fails the run when the real Band profile differs from the listing global-setup took.
export default function globalTeardown(): void {
  const saved = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as {
    dir: string;
    entries: [string, string][];
  };
  rmSync(SNAPSHOT_FILE, { force: true });
  const changed = diffListings(
    new Map(saved.entries) as ProfileListing,
    listRealProfile(saved.dir),
  );
  if (changed.length > 0) {
    throw new Error(
      `The desktop e2e run changed the real Band profile (${saved.dir}):\n  ${changed.slice(0, 50).join("\n  ")}`,
    );
  }
}
