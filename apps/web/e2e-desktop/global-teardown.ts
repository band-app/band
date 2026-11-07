import { readFileSync, rmSync } from "node:fs";
import { sweepSimulatorTestDevices } from "../../../scripts/test-env.mjs";
import { SNAPSHOT_FILE } from "./global-setup";
import { diffListings, listRealProfile, type ProfileListing } from "./helpers/profile-guard";
import { listBandDevices, newBandDevices } from "./helpers/simulator-guard";

// Fails the run when the real Band profile differs from the listing global-setup took.
export default function globalTeardown(): void {
  const saved = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as {
    dir: string;
    entries: [string, string][];
    bandDevices: string[] | null;
  };
  rmSync(SNAPSHOT_FILE, { force: true });
  // The run's own band-test-* devices go first. A "Band – " device is never deleted here: it is the failure.
  sweepSimulatorTestDevices({ prefix: process.env.BAND_SIMULATOR_NAME_PREFIX });
  const newDevices = newBandDevices(saved.bandDevices, listBandDevices());
  const changed = diffListings(
    new Map(saved.entries) as ProfileListing,
    listRealProfile(saved.dir),
  );
  if (newDevices.length > 0) {
    throw new Error(
      `The desktop e2e run left simulator devices that use the real "Band" name prefix, so a test ran without its own prefix:\n  ${newDevices.join("\n  ")}`,
    );
  }
  if (changed.length > 0) {
    throw new Error(
      `The desktop e2e run changed the real Band profile (${saved.dir}):\n  ${changed.slice(0, 50).join("\n  ")}`,
    );
  }
}
