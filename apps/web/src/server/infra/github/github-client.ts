import type { GitHubRepoRef } from "./github-repo-ref";

const FETCH_TIMEOUT_MS = 10_000;
/** GitHub's 64px avatars are a few KB. Anything much larger is not one. */
const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 2;
/** Where github.com redirects `/<login>.png`. */
const GITHUB_AVATAR_CDN = "avatars.githubusercontent.com";
/**
 * Raster types only. The bytes are served back from Band's own origin, where
 * an SVG opened directly (not through `<img>`) would run its script with the
 * user's session. A host is trusted as GitHub by name alone, so it must not
 * be able to choose an active type.
 */
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Outcome of one avatar fetch:
 * - `image`: raster bytes to cache.
 * - `missing`: GitHub answered, and there is no usable avatar (404, a
 *   non-raster type, an empty or oversized body). Worth remembering.
 * - `unavailable`: GitHub could not be asked (offline, timeout, 5xx, a
 *   redirect somewhere unexpected). Worth retrying later.
 */
export type AvatarFetchResult =
  | { kind: "image"; bytes: Buffer; contentType: string }
  | { kind: "missing" }
  | { kind: "unavailable"; reason: string };

/**
 * Outbound HTTP to GitHub. Only avatar downloads today.
 *
 * `BAND_GITHUB_URL` replaces `https://github.com` so tests can point the
 * server at a local stub. It is read on every call, not at module load.
 */
export class GitHubClient {
  async fetchAvatar(ref: Pick<GitHubRepoRef, "host" | "owner">): Promise<AvatarFetchResult> {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    try {
      let url = new URL(avatarUrl(ref));
      const origin = url.origin;
      for (let hop = 0; ; hop++) {
        const res = await fetch(url, { signal, redirect: "manual" });
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel();
          const location = res.headers.get("location");
          const next = location ? new URL(location, url) : null;
          const allowed =
            next &&
            (next.origin === origin ||
              (ref.host === "github.com" &&
                next.protocol === "https:" &&
                next.hostname === GITHUB_AVATAR_CDN));
          if (!next || !allowed || hop >= MAX_REDIRECTS) {
            return { kind: "unavailable", reason: `redirect to ${location ?? "(none)"}` };
          }
          url = next;
          continue;
        }
        return await readAvatar(res);
      }
    } catch (err) {
      return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

async function readAvatar(res: Response): Promise<AvatarFetchResult> {
  if (res.status === 404) {
    await res.body?.cancel();
    return { kind: "missing" };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { kind: "unavailable", reason: `HTTP ${res.status}` };
  }
  const contentType = res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  const declaredLength = Number(res.headers.get("content-length") ?? 0);
  if (!ALLOWED_TYPES.has(contentType) || declaredLength > MAX_AVATAR_BYTES || !res.body) {
    await res.body?.cancel();
    return { kind: "missing" };
  }

  // Count bytes as they arrive, so a body without an honest
  // Content-Length cannot grow the heap past the cap.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AVATAR_BYTES) {
      await reader.cancel();
      return { kind: "missing" };
    }
    chunks.push(value);
  }
  if (total === 0) return { kind: "missing" };
  return { kind: "image", bytes: Buffer.concat(chunks), contentType };
}

/** GitHub and GHES both serve a login's avatar at `/<login>.png`. */
function avatarUrl(ref: Pick<GitHubRepoRef, "host" | "owner">): string {
  const base =
    ref.host === "github.com"
      ? (process.env.BAND_GITHUB_URL || "https://github.com").replace(/\/+$/, "")
      : `https://${ref.host}`;
  return `${base}/${encodeURIComponent(ref.owner)}.png?size=64`;
}
