/**
 * The app may be newer than the hub it talks to (the desktop app updates itself, a
 * remote hub does not). Compare by major and minor: a patch difference is not worth a notice.
 */

export type VersionRelation = "newer" | "same" | "older";

export const NEEDS_NEWER_HUB = "This needs a newer hub. Update the hub to use it.";

function majorMinor(version: string): [number, number] | null {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** How the app's version relates to the hub's, or null when either does not parse. */
export function compareHubVersion(app: string, hub: string): VersionRelation | null {
  const a = majorMinor(app);
  const h = majorMinor(hub);
  if (!a || !h) return null;
  if (a[0] !== h[0]) return a[0] > h[0] ? "newer" : "older";
  if (a[1] !== h[1]) return a[1] > h[1] ? "newer" : "older";
  return "same";
}

/** A tRPC call to a procedure the hub does not have. */
export function isMissingProcedure(err: unknown): boolean {
  const e = err as { data?: { code?: string; httpStatus?: number }; message?: string } | null;
  return e?.data?.code === "NOT_FOUND" && /No procedure found/i.test(e.message ?? "");
}

let appNewerThanHub = false;

/** Set once the hub's version is known. */
export function setAppNewerThanHub(value: boolean): void {
  appNewerThanHub = value;
}

/**
 * A missing procedure that an older hub explains. A same-version hub that lacks one is a real
 * error and stays visible.
 */
export function isOldHubGap(err: unknown): boolean {
  return appNewerThanHub && isMissingProcedure(err);
}
