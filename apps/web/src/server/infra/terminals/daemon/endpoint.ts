import { randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";

/**
 * Who may touch the daemon's socket path, and how. Ported from orca's
 * `src/main/daemon/daemon-endpoint-ownership.ts`; its `AGENTS.md` records the
 * bugs behind each rule:
 *
 *   - Only a daemon publishing itself may change the directory entry, and only
 *     to replace an entry it has just proven dead.
 *   - Nobody removes a name they did not create. `net.Server.close()` unlinks
 *     the path it bound unconditionally, which once deleted a live
 *     replacement's socket; binding a private name first means the only path
 *     our server can ever unlink is its own.
 *   - Only a refused or missing connect proves the incumbent dead. A timeout or
 *     EPERM proves nothing and must be treated as alive.
 *   - `link` first (it fails on EEXIST and forces the liveness question), then
 *     `rename` to replace a proven-dead entry in one syscall. Never
 *     unlink-then-link: that leaves the name absent in between.
 *   - Never remove the endpoint on shutdown. The next publisher replaces it.
 */

const PROBE_TIMEOUT_MS = 500;
const PUBLISH_ATTEMPTS = 3;

/**
 * `connected`: something is listening. `missing` / `refused`: nothing is, so
 * the name may be replaced. `unknown`: the probe itself failed, which is not
 * evidence of anything.
 */
export type ProbeOutcome = "connected" | "missing" | "refused" | "unknown";

export function isProvenDead(outcome: ProbeOutcome): boolean {
  return outcome === "missing" || outcome === "refused";
}

export function probeEndpoint(socketPath: string): Promise<ProbeOutcome> {
  let occupied = false;
  try {
    // lstat, not exists: a dangling symlink occupies the name while `stat`
    // (and so `existsSync`) reports it absent.
    lstatSync(socketPath);
    occupied = true;
  } catch (err) {
    return Promise.resolve(errorCode(err) === "ENOENT" ? "missing" : "unknown");
  }
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath });
    let settled = false;
    const settle = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle("unknown"), PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle("connected"));
    socket.once("error", (err) => {
      const code = errorCode(err);
      // A non-socket at the name reports ENOTSOCK on macOS and ECONNREFUSED
      // on Linux; either way nothing can ever serve it. ENOENT after the lstat
      // above saw an entry means a dangling symlink: occupied but unservable.
      if (code === "ECONNREFUSED" || code === "ENOTSOCK") settle("refused");
      else if (code === "ENOENT") settle(occupied ? "refused" : "missing");
      else settle("unknown");
    });
  });
}

/** A directory entry, by device and inode. Birth time is unreliable for this. */
export interface EndpointIdentity {
  dev: bigint;
  ino: bigint;
}

/** A private name next to `socketPath` to bind before publishing. */
export function privateBindPath(socketPath: string): string {
  return join(dirname(socketPath), `.p${randomBytes(5).toString("hex")}`);
}

export type PublishOutcome =
  | { status: "published"; identity: EndpointIdentity }
  /** A live daemon owns the name. Connect to it; never serve beside it. */
  | { status: "occupied" }
  /** Another daemon replaced us right after we published. Do not serve. */
  | { status: "lost" }
  /** The incumbent could not be classified, so it was left alone. */
  | { status: "inconclusive" };

/**
 * Publish the listener bound at `boundPath` under `canonicalPath`: an
 * exclusive `link`, or on EEXIST a proven-dead check followed by one `rename`.
 * On `published` the private name is gone; on any other outcome the caller
 * still owns `boundPath` and must close its server (which unlinks it).
 */
export async function publishEndpoint(
  boundPath: string,
  canonicalPath: string,
): Promise<PublishOutcome> {
  const identity = entryIdentity(boundPath, statSync);
  if (!identity) throw new Error(`Cannot stat the bound daemon socket at ${boundPath}`);
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    try {
      linkSync(boundPath, canonicalPath);
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      const replaced = await replaceProvenDead(boundPath, canonicalPath);
      if (replaced === "stale") continue;
      if (replaced !== "renamed") return replaced;
      return confirmPublished(canonicalPath, identity);
    }
    try {
      unlinkSync(boundPath);
    } catch {
      // Harmless: clients use the canonical name, and this one is ours alone.
    }
    return confirmPublished(canonicalPath, identity);
  }
  // Outrun every time: the name keeps changing hands, but no probe ever
  // connected, so nothing proves an owner either.
  return { status: "inconclusive" };
}

async function replaceProvenDead(
  boundPath: string,
  canonicalPath: string,
): Promise<"renamed" | "stale" | { status: "occupied" } | { status: "inconclusive" }> {
  // Read before probing: `rename` replaces whatever is there, so without this
  // a slow probe could license destroying a daemon that published meanwhile.
  const proven = entryIdentity(canonicalPath, lstatSync);
  const first = await probeEndpoint(canonicalPath);
  if (first === "connected") return { status: "occupied" };
  if (!isProvenDead(first)) return { status: "inconclusive" };
  const now = entryIdentity(canonicalPath, lstatSync);
  if (!proven || !now || proven.dev !== now.dev || proven.ino !== now.ino) return "stale";
  // Ask again rather than trust dev+ino: the dead entry's inode can be freed
  // and handed straight to a replacement. Whether anything serves is the
  // property that matters, and connecting asks it.
  const second = await probeEndpoint(canonicalPath);
  if (second === "connected") return { status: "occupied" };
  if (!isProvenDead(second)) return { status: "inconclusive" };
  renameSync(boundPath, canonicalPath);
  return "renamed";
}

/**
 * Two daemons can prove the same entry dead and both replace it; the loser
 * must not serve. Our listener holds the inode open, so it can't be recycled
 * while we compare.
 */
function confirmPublished(canonicalPath: string, identity: EndpointIdentity): PublishOutcome {
  let published: EndpointIdentity | null;
  try {
    const stats = statSync(canonicalPath, { bigint: true });
    published = { dev: stats.dev, ino: stats.ino };
  } catch (err) {
    return errorCode(err) === "ENOENT" ? { status: "lost" } : { status: "inconclusive" };
  }
  return published.dev === identity.dev && published.ino === identity.ino
    ? { status: "published", identity: published }
    : { status: "lost" };
}

/**
 * Whether `canonicalPath` still names the socket we published. `lost` only on
 * positive evidence (the entry is gone or is another inode); anything else,
 * such as EACCES, is `indeterminate` and must not retire a healthy daemon.
 */
export function endpointOwnership(
  canonicalPath: string,
  owned: EndpointIdentity,
): "owned" | "lost" | "indeterminate" {
  try {
    const stats = statSync(canonicalPath, { bigint: true });
    return stats.dev === owned.dev && stats.ino === owned.ino ? "owned" : "lost";
  } catch (err) {
    return errorCode(err) === "ENOENT" ? "lost" : "indeterminate";
  }
}

/**
 * Create `dir` (mode 0700) if needed and verify it is a real directory that
 * only we can use. Refuses a symlink or another user's directory: under
 * `/tmp` either could be a planted trap. Tightens our own directory's mode.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  const uid = process.getuid?.();
  if (!stats.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (uid !== undefined && stats.uid !== uid) throw new Error(`${dir} is owned by another user`);
  if ((stats.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function entryIdentity(
  path: string,
  stat: typeof statSync | typeof lstatSync,
): EndpointIdentity | null {
  try {
    const stats = stat(path, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}
