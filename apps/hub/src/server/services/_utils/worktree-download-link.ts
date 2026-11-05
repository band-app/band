import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveAdminToken } from "../state";

/** Path prefix of the signed one-file download route, answered before the device-token check. */
export const WORKTREE_DOWNLOAD_PREFIX = "/api/worktree-download/";

const DOWNLOAD_TTL_MS = 5 * 60 * 1000;

/** The HMAC key, derived from the admin token with its own purpose string (not the preview one). */
function signingKey(): Buffer {
  const token = resolveAdminToken(process.env.BAND_ADMIN_TOKEN).token;
  return createHmac("sha256", token).update("worktree-download-v1").digest();
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "");
}

function sign(worktreeId: string, path: string, expiresAt: number): string {
  return createHmac("sha256", signingKey())
    .update(`${worktreeId}\n${normalize(path)}\n${expiresAt}`)
    .digest("hex");
}

/**
 * A URL a file manager or another app can fetch without the hub's auth
 * header. The signature covers one worktree, the exact file path and an
 * expiry of five minutes. The URL is relative to the hub origin.
 */
export function worktreeDownloadUrl(worktreeId: string, path: string, now = Date.now()): string {
  const expiresAt = now + DOWNLOAD_TTL_MS;
  const grant = `${expiresAt}.${sign(worktreeId, path, expiresAt)}`;
  const encodedPath = normalize(path).split("/").map(encodeURIComponent).join("/");
  return `${WORKTREE_DOWNLOAD_PREFIX}${encodeURIComponent(worktreeId)}/${grant}/${encodedPath}`;
}

/** Whether `grant` (`<expiresAt>.<signature>`) is a live signature for exactly this worktree and file. */
export function verifyWorktreeDownloadGrant(
  worktreeId: string,
  grant: string,
  filePath: string,
  now = Date.now(),
): boolean {
  if (filePath.includes("\0")) return false;
  const [expiry, signature, ...extra] = grant.split(".");
  const expiresAt = Number(expiry);
  if (extra.length > 0 || !signature || !Number.isSafeInteger(expiresAt) || expiresAt < now) {
    return false;
  }
  const expected = Buffer.from(sign(worktreeId, filePath, expiresAt), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
