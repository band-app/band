/**
 * Band browser profiles on the desktop side: one Electron session partition
 * per profile, so each profile has its own cookies, storage and cache.
 *
 * The web server stores which profiles exist and which one each project
 * uses (`browserProfiles.*` tRPC); the desktop only needs the id. The
 * built-in Default profile (`null`) is the original `persist:band-browser`
 * partition, so tabs from before profiles existed keep their logins.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { app, type Session, session } from "electron";

/** Partition of the built-in Default profile. */
export const BROWSER_PARTITION = "persist:band-browser";

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

/**
 * Profiles deleted in this app run. A view spawned for one of these falls
 * back to Default, so a pane that hasn't noticed the deletion yet can't
 * write cookies back into a partition that was just wiped.
 */
const retiredProfiles = new Set<string>();

export function retireProfile(profileId: string): void {
  retiredProfiles.add(profileId);
}

export function isRetiredProfile(profileId: string | null): boolean {
  return profileId !== null && retiredProfiles.has(profileId);
}

/**
 * Ids of the profile partitions on disk. Electron stores
 * `persist:<name>` under `<sessionData>/Partitions/<name>`.
 */
export function listProfilePartitionsOnDisk(): string[] {
  const dir = join(app.getPath("sessionData"), "Partitions");
  const prefix = PROFILE_PARTITION_PREFIX.slice("persist:".length);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter(isValidProfileId);
}

const bandActionHandler = () => new Response(null, { status: 204 });
const prepared = new WeakSet<Session>();

/**
 * Per-session setup every browser-pane session needs. Each partition's
 * `Session` has its own protocol registry, so the no-op `band-action://`
 * handler (see `apps/desktop/src/main/index.ts`) is registered on each one;
 * without it an in-view error page's buttons would pop the macOS "no
 * application set to open this URL" dialog.
 */
export function prepareBrowserSession(sess: Session): Session {
  if (prepared.has(sess)) return sess;
  prepared.add(sess);
  if (!sess.protocol.isProtocolHandled("band-action")) {
    sess.protocol.handle("band-action", bandActionHandler);
  }
  return sess;
}

/** The prepared `Session` for a profile. */
export function sessionForProfile(profileId: string | null | undefined): Session {
  return prepareBrowserSession(session.fromPartition(partitionForProfile(profileId)));
}
