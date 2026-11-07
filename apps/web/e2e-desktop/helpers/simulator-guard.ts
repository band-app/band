import { listSimulatorNames } from "../../../../scripts/test-env.mjs";

/** The prefix of every device Band creates for a person: "Band" and an en dash. Tests must never produce one. */
export const REAL_DEVICE_PREFIX = "Band – ";

/** Names of the devices in the account's default set that start with "Band – ", or null without xcrun. Read-only. */
export function listBandDevices(): string[] | null {
  return listSimulatorNames(REAL_DEVICE_PREFIX);
}

/** The names present after the run that were not there before. Empty when either listing is missing. */
export function newBandDevices(before: string[] | null, after: string[] | null): string[] {
  if (before === null || after === null) return [];
  const known = new Set(before);
  return after.filter((name) => !known.has(name));
}
