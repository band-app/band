/**
 * Band release versions: parsing, comparing, the worker/hub compatibility rule and the
 * command that updates a hub. Pure, so the hub, the worker and the UI share one answer.
 */

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LENIENT_SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** True for exactly `MAJOR.MINOR.PATCH` with no prefix, suffix or leading zeros. This is what may reach npm. */
export function isStrictSemver(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && STRICT_SEMVER.test(value);
}

/** Reads `1.2.3`, `v1.2.3` or `1.2.3-rc.1`. Null for anything else. */
export function parseSemver(value: string | null | undefined): Semver | null {
  if (typeof value !== "string") return null;
  const m = LENIENT_SEMVER.exec(value.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Negative when `a` is older than `b`. Null when either is not a version. */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

/** The version a worker's hello carries: its own `version`, else the one in `band-worker@<version>`. */
export function workerVersionOf(hello: { version?: unknown; buildId?: unknown }): string | null {
  if (typeof hello.version === "string" && parseSemver(hello.version)) return hello.version;
  if (typeof hello.buildId === "string") {
    const m = /^band-worker@(.+)$/.exec(hello.buildId);
    if (m && parseSemver(m[1])) return m[1] as string;
  }
  return null;
}

export type VersionRelation = "current" | "behind" | "ahead" | "unknown";

/** How a worker's version relates to the hub's. `behind` also means lower by a patch. */
export function relationToHub(worker: string | null | undefined, hub: string): VersionRelation {
  const cmp = compareVersions(worker, hub);
  if (cmp === null) return "unknown";
  return cmp === 0 ? "current" : cmp < 0 ? "behind" : "ahead";
}

/**
 * The link refusal for a worker too far from the hub, or null when they may connect.
 * Version 0.x: "minor" is the middle number. Within one minor either way is allowed,
 * and a different major is always refused. An unknown version is never refused.
 */
export function compatibilityProblem(
  worker: string | null | undefined,
  hub: string | null | undefined,
): string | null {
  const w = parseSemver(worker);
  const h = parseSemver(hub);
  if (!w || !h) return null;
  if (w.major === h.major && Math.abs(w.minor - h.minor) <= 1) return null;
  const hubV = `${h.major}.${h.minor}.${h.patch}`;
  const workerV = `${w.major}.${w.minor}.${w.patch}`;
  const older = (compareVersions(workerV, hubV) as number) < 0;
  return older
    ? `worker ${workerV} is too old for hub ${hubV}, update it to ${hubV}`
    : `worker ${workerV} is too new for hub ${hubV}, update the hub to ${workerV} or install worker ${hubV}`;
}

/** Machine-readable code a refusal carries on the link, so a worker can wait instead of retrying. */
export const VERSION_REFUSED_CODE = "version-incompatible";

export const INSTALL_METHODS = ["compose", "helm", "k8s", "docker"] as const;
export type InstallMethod = (typeof INSTALL_METHODS)[number];

export function parseInstallMethod(value: string | undefined): InstallMethod | null {
  const v = value?.trim().toLowerCase();
  return (INSTALL_METHODS as readonly string[]).includes(v ?? "") ? (v as InstallMethod) : null;
}

export const HUB_IMAGE = "ghcr.io/band-app/band-hub";

/** The command that updates a hub installed by `method` to `version`. `method` null is an unknown install. */
export function hubUpdateCommand(method: InstallMethod | null, version: string): string {
  switch (method) {
    case "compose":
      return `BAND_VERSION=${version} docker compose pull && BAND_VERSION=${version} docker compose up -d`;
    case "helm":
      return `helm upgrade band-hub <chart> --reuse-values --set image.tag=${version}`;
    case "k8s":
      return `kubectl set image deployment/band-hub hub=${HUB_IMAGE}:${version}`;
    case "docker":
      return `docker pull ${HUB_IMAGE}:${version} && docker stop band-hub && docker rm band-hub && docker run -d --name band-hub <your usual options> ${HUB_IMAGE}:${version}`;
    default:
      return `Pull ${HUB_IMAGE}:${version} and recreate the container.`;
  }
}

/** The command for updating a worker by hand. */
export function workerUpdateCommand(version: string): string {
  return `npm i -g @band-app/worker@${version}`;
}
