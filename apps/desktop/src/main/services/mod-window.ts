import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Desktop window options of a client mod (`contributes.mod.window` in `band-extension.json`).
 * The hub validates the manifest when it loads it. The main process reads the same files at
 * window creation, before the hub's page loads, and checks each value again.
 */

export const MATERIALS = [
  "none",
  "sidebar",
  "titlebar",
  "selection",
  "menu",
  "popover",
  "header",
  "sheet",
  "window",
  "hud",
  "fullscreen-ui",
  "tooltip",
  "content",
  "under-window",
  "under-page",
] as const;
export type Material = (typeof MATERIALS)[number];
export type Vibrancy = Exclude<Material, "none">;

export interface ModWindowOptions {
  material?: Material;
  titleBarStyle?: "hiddenInset" | "hidden" | "default";
  trafficLightPosition?: { x: number; y: number };
  /** An empty native toolbar: the large corner radius of a toolbar window. */
  toolbar?: "none" | "unified" | "compact";
}

/** What Band does without a mod. */
export const DEFAULT_MATERIAL: Material = "sidebar";
export const DEFAULT_TITLE_BAR = "hiddenInset";
export const DEFAULT_TRAFFIC_LIGHTS = { x: 13, y: 10 };

const isInt = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 200;

/** Picks the valid fields out of a manifest's `contributes.mod.window`. */
export function parseModWindow(raw: unknown): ModWindowOptions {
  if (!raw || typeof raw !== "object") return {};
  const w = raw as Record<string, unknown>;
  const out: ModWindowOptions = {};
  if (typeof w.material === "string" && (MATERIALS as readonly string[]).includes(w.material)) {
    out.material = w.material as Material;
  }
  if (
    w.titleBarStyle === "hiddenInset" ||
    w.titleBarStyle === "hidden" ||
    w.titleBarStyle === "default"
  ) {
    out.titleBarStyle = w.titleBarStyle;
  }
  if (w.toolbar === "none" || w.toolbar === "unified" || w.toolbar === "compact") {
    out.toolbar = w.toolbar;
  }
  const t = w.trafficLightPosition as { x?: unknown; y?: unknown } | undefined;
  if (t && isInt(t.x) && isInt(t.y)) out.trafficLightPosition = { x: t.x, y: t.y };
  return out;
}

/**
 * The window options of the installed mods, merged in install (folder name) order so a later mod
 * wins per field. Empty when mods are off (`BAND_MODS=off`) or no extension has a mod.
 */
export function readModWindowOptions(
  extensionsDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ModWindowOptions {
  if (env.BAND_MODS === "off" || !existsSync(extensionsDir)) return {};
  let merged: ModWindowOptions = {};
  let folders: string[] = [];
  try {
    folders = readdirSync(extensionsDir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return {};
  }
  for (const folder of folders) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(extensionsDir, folder, "band-extension.json"), "utf8"),
      );
      if (manifest?.id !== folder) continue;
      merged = { ...merged, ...parseModWindow(manifest?.contributes?.mod?.window) };
    } catch {
      // The hub lists a broken manifest; the window keeps its defaults.
    }
  }
  return merged;
}

export interface WindowChrome {
  /** The material the mod asked for, else the default. */
  material: Material;
  titleBarStyle: "hiddenInset" | "hidden" | "default";
  trafficLightPosition: { x: number; y: number };
  toolbar: "none" | "unified" | "compact";
}

/** The `NSWindowToolbarStyle` value for a toolbar option. */
export const TOOLBAR_STYLE = { unified: 3, compact: 4 } as const;

export function resolveWindowChrome(opts: ModWindowOptions): WindowChrome {
  return {
    material: opts.material ?? DEFAULT_MATERIAL,
    titleBarStyle: opts.titleBarStyle ?? DEFAULT_TITLE_BAR,
    trafficLightPosition: opts.trafficLightPosition ?? DEFAULT_TRAFFIC_LIGHTS,
    toolbar: opts.toolbar ?? "none",
  };
}

/** The Electron `vibrancy` for a material: none for `none`, else the material itself. */
export function vibrancyFor(material: Material): Vibrancy | null {
  return material === "none" ? null : material;
}
