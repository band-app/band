/**
 * Band browser profiles on the desktop side: one Electron session partition
 * per profile, so each profile has its own cookies, storage and cache.
 *
 * The web server stores which profiles exist and which one each project
 * uses (`browserProfiles.*` tRPC); the desktop only needs the id. The
 * built-in Default profile (`null`) is the original `persist:band-browser`
 * partition, so tabs from before profiles existed keep their logins.
 *
 * A pane's `<webview>` picks its partition by attribute (the renderer
 * mirrors `partitionForProfile` in `apps/web/src/lib/browser-webview.ts`),
 * `guest-policy.ts` admits only these partitions, and the guest manager
 * prepares each session when its first guest attaches.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { app, type Session, session } from "electron";
import { BROWSER_PARTITION } from "./guest-policy.js";

const PROFILE_PARTITION_PREFIX = "persist:band-browser-profile-";

/** Same alphabet the server accepts (`BROWSER_PROFILE_ID_PATTERN`). */
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidProfileId(profileId: unknown): profileId is string {
  return typeof profileId === "string" && PROFILE_ID_PATTERN.test(profileId);
}

/**
 * Partition name for a profile. `null`/`undefined` is Default. Throws on an
 * id outside the safe alphabet, since the name maps to a directory under
 * the app's `Partitions/`.
 */
export function partitionForProfile(profileId: string | null | undefined): string {
  if (profileId === null || profileId === undefined) return BROWSER_PARTITION;
  if (!isValidProfileId(profileId)) throw new Error("Invalid browser profile id");
  return `${PROFILE_PARTITION_PREFIX}${profileId}`;
}

/** The `Session` behind a profile's partition. */
export function sessionForProfile(profileId: string | null | undefined): Session {
  return session.fromPartition(partitionForProfile(profileId));
}

/**
 * Profiles deleted in this app run. An offscreen page spawned for one of
 * these falls back to Default, so nothing writes cookies back into a
 * partition that was just wiped.
 */
const retiredProfiles = new Set<string>();

export function retireProfile(profileId: string): void {
  retiredProfiles.add(profileId);
}

export function isRetiredProfile(profileId: string | null | undefined): boolean {
  return typeof profileId === "string" && retiredProfiles.has(profileId);
}

/**
 * Ids of the profile partitions on disk. Electron stores
 * `persist:<name>` under `<sessionData>/Partitions/<name>`.
 */
export async function listProfilePartitionsOnDisk(): Promise<string[]> {
  const dir = join(app.getPath("sessionData"), "Partitions");
  const prefix = PROFILE_PARTITION_PREFIX.slice("persist:".length);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter(isValidProfileId);
}
