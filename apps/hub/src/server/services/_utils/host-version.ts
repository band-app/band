/** What the Hosts screen and the update panel show about a host's version, worked out in one place. */

import {
  compareVersions,
  compatibilityProblem,
  parseSemver,
  relationToHub,
  type VersionRelation,
  workerUpdateCommand,
} from "@band-app/shared/versions";
import { UNRELEASED_VERSION } from "./hub-version";

export type ServiceManagerName = "launchd" | "systemd";

export interface HostVersionView {
  /** The worker's release version, or null when it never said (a worker from before version reporting). */
  workerVersion: string | null;
  /** `refused` when the hub turned the worker away for being too far from its version. */
  versionState: VersionRelation | "refused";
  /** Why the hub refused the link, or null. */
  updateRequired: string | null;
  /** What restarts the worker, or null when nothing supervises it. */
  serviceManager: ServiceManagerName | null;
  /** The version an update installs, or null when there is nothing to update to. */
  updateTarget: string | null;
  /** True when the Update button works: the worker is online, supervised and not current. */
  canUpdate: boolean;
  /** The command to run on the worker by hand, shown when the button cannot be. */
  manualCommand: string | null;
}

interface HostFacts {
  id: string;
  status: string;
  version: string | null;
  info: Record<string, unknown> | null;
}

/**
 * The version a worker should be updated to. A worker behind (or of unknown version) goes to the
 * hub's version, so the hub never ends up older than its workers. A current worker goes to the
 * latest release when that stays within a minor of the hub, since workers are updated first and the
 * hub last. An ahead worker has nothing to update to.
 */
export function updateTargetFor(
  relation: VersionRelation,
  hubVersion: string,
  latest: string | null,
): string | null {
  if (relation === "behind" || relation === "unknown") {
    // A hub run from source has no release to move a worker to.
    if (hubVersion === UNRELEASED_VERSION) return null;
    return parseSemver(hubVersion) ? hubVersion : null;
  }
  if (relation === "current" && latest) {
    const newer = (compareVersions(latest, hubVersion) ?? 0) > 0;
    return newer && compatibilityProblem(latest, hubVersion) === null ? latest : null;
  }
  return null;
}

export function describeHostVersion(
  host: HostFacts,
  hubVersion: string,
  latest: string | null,
): HostVersionView {
  if (host.id === "local") {
    return {
      workerVersion: hubVersion,
      versionState: "current",
      updateRequired: null,
      serviceManager: null,
      updateTarget: null,
      canUpdate: false,
      manualCommand: null,
    };
  }
  const workerVersion = parseSemver(host.version) ? host.version : null;
  const relation = relationToHub(workerVersion, hubVersion);
  const required = typeof host.info?.updateRequired === "string" ? host.info.updateRequired : null;
  const refused = required !== null && host.status !== "online";
  const manager = host.info?.serviceManager;
  const serviceManager = manager === "launchd" || manager === "systemd" ? manager : null;
  const updateTarget = updateTargetFor(relation, hubVersion, latest);
  return {
    workerVersion,
    versionState: refused ? "refused" : relation,
    updateRequired: refused ? required : null,
    serviceManager,
    updateTarget,
    canUpdate: host.status === "online" && serviceManager !== null && updateTarget !== null,
    manualCommand: updateTarget ? workerUpdateCommand(updateTarget) : null,
  };
}
