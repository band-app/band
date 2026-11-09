import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** What `native/band-native.mm` exports. Every call runs on the main thread. */
export interface BandNative {
  /** 1 expanded, 3 unified, 4 unified compact. */
  setWindowToolbar(handle: Buffer, style: number): void;
  /** PNG bytes of an SF Symbol (black on transparent), or null for an unknown name. */
  symbolPNG(name: string, pointSize: number, weight: number, scale: number): Buffer | null;
}

/** Where `native/build.mjs` writes the addon, relative to `dist/main/main/services`. In a packaged app it is unpacked from the asar. */
export function nativeAddonPath(here: string = dirname(fileURLToPath(import.meta.url))): string {
  const path = join(here, "..", "..", "..", "..", "native", "build", "band-native.node");
  return path.replace(`app.asar${"/"}`, `app.asar.unpacked${"/"}`);
}

/**
 * Loads the optional addon. Returns null off macOS, when the file is missing or fails to load, or
 * when `BAND_FORCE_NATIVE_LOAD_FAIL=1` forces that failure (for the fallback test).
 */
export function loadNative(
  env: NodeJS.ProcessEnv = process.env,
  path: string = nativeAddonPath(),
  platform: NodeJS.Platform = process.platform,
): BandNative | null {
  if (platform !== "darwin" || env.BAND_FORCE_NATIVE_LOAD_FAIL === "1") return null;
  if (!existsSync(path)) return null;
  try {
    return createRequire(import.meta.url)(path) as BandNative;
  } catch {
    return null;
  }
}
