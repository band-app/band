import { createHmac, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";

import { resolveAdminToken } from "../state";

/** Path prefix of the signed worktree file route, answered before the device-token check. */
export const WORKTREE_PREVIEW_PREFIX = "/api/worktree-preview/";

const PREVIEW_TTL_MS = 60 * 60 * 1000;

/** The HMAC key, derived from the admin token so the token itself never signs a grant. */
function signingKey(): Buffer {
  const token = resolveAdminToken(process.env.BAND_ADMIN_TOKEN).token;
  return createHmac("sha256", token).update("worktree-preview-v1").digest();
}

function sign(worktreeId: string, dir: string, expiresAt: number): string {
  return createHmac("sha256", signingKey())
    .update(`${worktreeId}\n${dir}\n${expiresAt}`)
    .digest("hex");
}

/**
 * A URL a browser tab can load without the hub's auth header. The signature
 * covers one worktree, the directory of the previewed file and an expiry. The
 * grant sits in the path, so the relative URLs in a served page resolve under
 * it and carry it along, and the page can reach files in its own directory
 * and below, and nothing else.
 */
export function worktreePreviewUrl(worktreeId: string, path: string, now = Date.now()): string {
  const expiresAt = now + PREVIEW_TTL_MS;
  const dir = posix.dirname(path.replace(/^\/+/, ""));
  const encodedDir = Buffer.from(dir, "utf8").toString("base64url");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const grant = `${expiresAt}.${encodedDir}.${sign(worktreeId, dir, expiresAt)}`;
  return `${WORKTREE_PREVIEW_PREFIX}${encodeURIComponent(worktreeId)}/${grant}/${encodedPath}`;
}

/**
 * Whether `grant` (`<expiresAt>.<dir>.<signature>`) is a live signature for
 * `worktreeId` and `filePath` lies in the signed directory or below it.
 */
export function verifyWorktreePreviewGrant(
  worktreeId: string,
  grant: string,
  filePath: string,
  now = Date.now(),
): boolean {
  if (filePath.includes("\0")) return false;
  const [expiry, encodedDir, signature, ...extra] = grant.split(".");
  const expiresAt = Number(expiry);
  if (
    extra.length > 0 ||
    encodedDir === undefined ||
    !signature ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < now
  ) {
    return false;
  }
  const dir = Buffer.from(encodedDir, "base64url").toString("utf8");
  const expected = Buffer.from(sign(worktreeId, dir, expiresAt), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const target = posix.normalize(filePath.replace(/^\/+/, ""));
  if (target === ".." || target.startsWith("../")) return false;
  return dir === "." || target === dir || target.startsWith(`${dir}/`);
}
