import { parseBandMediaUrl } from "@band-app/shared/band-media";
import { hubAssetUrl } from "./hub-config";

/**
 * The URL an `<img>`, `<video>` or link should load for a `band://media/<id>`
 * source. Other sources pass through unchanged. A hub on another origin gets
 * the token in the query string, like other hub assets.
 */
export function mediaSrc(src: string): string {
  const id = parseBandMediaUrl(src);
  return id ? hubAssetUrl(`/media/${id}`) : src;
}
