/** The release version of this hub, and how it was installed. */

import { type InstallMethod, isStrictSemver, parseInstallMethod } from "@band-app/shared/versions";
import pkg from "../../../../package.json" with { type: "json" };

// Imported, not read at run time, so the bundle (which has no package.json beside it) has it too.
// The release builds bump the package.json files first (`scripts/bump-version.mjs`).
const PACKAGE_VERSION: string = pkg.version;

/** What `apps/hub/package.json` says in the repo. A hub that still reports it was built from source, not released. */
export const UNRELEASED_VERSION = "0.1.0";

/**
 * `BAND_HUB_VERSION` replaces the bundled version, for a deployment that cannot rebuild and for tests
 * that need a hub at a released version. Anything but plain MAJOR.MINOR.PATCH is ignored.
 */
export const HUB_VERSION: string = isStrictSemver(process.env.BAND_HUB_VERSION)
  ? process.env.BAND_HUB_VERSION
  : PACKAGE_VERSION;

/**
 * True for the unreleased default and for a prerelease stamped on it, such as the nightly build's
 * `0.1.0-nightly.<date>.<sha>`. Neither has a release to compare workers against.
 */
export function isUnreleasedVersion(version: string): boolean {
  return version === UNRELEASED_VERSION || version.startsWith(`${UNRELEASED_VERSION}-`);
}

/** True for a hub run from source or built nightly. It has no release to compare workers against. */
export const HUB_VERSION_UNRELEASED = isUnreleasedVersion(HUB_VERSION);

/** `BAND_INSTALL_METHOD`, set by the compose file, the Kubernetes manifest and the image. Read on every call. */
export function hubInstallMethod(env: NodeJS.ProcessEnv = process.env): InstallMethod | null {
  return parseInstallMethod(env.BAND_INSTALL_METHOD);
}
