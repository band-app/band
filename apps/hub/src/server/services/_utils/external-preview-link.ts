import { createHmac, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import { resolveAdminToken } from "../state";

/** Path prefix of the signed external HTML route, answered before the device-token check. */
export const EXTERNAL_PREVIEW_PREFIX = "/api/external-preview/";

const PREVIEW_TTL_MS = 60 * 60 * 1000;

/** The HMAC key, derived from the admin token with its own purpose string. */
function signingKey(): Buffer {
  const token = resolveAdminToken(process.env.BAND_ADMIN_TOKEN).token;
  return createHmac("sha256", token).update("external-preview-v1").digest();
}

function sign(worktreeId: string, dir: string, expiresAt: number): string {
  return createHmac("sha256", signingKey())
    .update(`${worktreeId}\n${dir}\n${expiresAt}`)
    .digest("hex");
}

/** Whether `path` is an absolute path with no `..`, `.` or empty segment, NUL or newline. */
export function isPlainAbsolutePath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\n")) return false;
  return !path
    .slice(1)
    .split("/")
    .some((part) => part === ".." || part === "." || part === "");
}

/**
 * A URL a sandboxed iframe can load without the hub's auth header, for an HTML file outside any
 * worktree. The signature covers one worktree, the absolute folder of the file and an expiry. The
 * grant sits in the path, so the relative URLs inside the page resolve under it and carry it, and
 * the page reaches files in its own folder and below, nothing else. The URL is relative to the hub.
 */
export function externalPreviewUrl(worktreeId: string, absolutePath: string, now = Date.now()) {
  if (!isPlainAbsolutePath(absolutePath)) throw new Error("Absolute path required");
  const expiresAt = now + PREVIEW_TTL_MS;
  const dir = posix.dirname(absolutePath);
  const encodedDir = Buffer.from(dir, "utf8").toString("base64url");
  const encodedPath = absolutePath.slice(1).split("/").map(encodeURIComponent).join("/");
  const grant = `${expiresAt}.${encodedDir}.${sign(worktreeId, dir, expiresAt)}`;
  return `${EXTERNAL_PREVIEW_PREFIX}${encodeURIComponent(worktreeId)}/${grant}/${encodedPath}`;
}

/**
 * The signed folder when `grant` (`<expiresAt>.<dir>.<signature>`) is live for `worktreeId` and
 * `absolutePath` lies in that folder or below it, else null.
 */
export function verifyExternalPreviewGrant(
  worktreeId: string,
  grant: string,
  absolutePath: string,
  now = Date.now(),
): string | null {
  if (!isPlainAbsolutePath(absolutePath)) return null;
  const [expiry, encodedDir, signature, ...extra] = grant.split(".");
  const expiresAt = Number(expiry);
  if (
    extra.length > 0 ||
    encodedDir === undefined ||
    !signature ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < now
  ) {
    return null;
  }
  const dir = Buffer.from(encodedDir, "base64url").toString("utf8");
  const expected = Buffer.from(sign(worktreeId, dir, expiresAt), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const inside = dir === "/" || absolutePath.startsWith(`${dir}/`);
  return inside ? dir : null;
}
