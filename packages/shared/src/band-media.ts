/** `band://media/<id>` links: how context files refer to blobs in the hub's media store. */

const BAND_MEDIA = /^band:\/\/media\/([0-9a-f]{64})$/;

export function bandMediaUrl(id: string): string {
  return `band://media/${id}`;
}

/** The media id in a `band://media/<id>` link, or null when the string is not one. */
export function parseBandMediaUrl(src: string): string | null {
  return BAND_MEDIA.exec(src.trim())?.[1] ?? null;
}

/**
 * The URL to load a `band://media/<id>` link from. Any other string comes back
 * unchanged. `hubUrl` is the hub's origin, or empty when the UI is served by it.
 */
export function resolveBandMediaUrl(src: string, hubUrl = ""): string {
  const id = parseBandMediaUrl(src);
  return id ? `${hubUrl.replace(/\/$/, "")}/media/${id}` : src;
}
