/**
 * Client mods. An installed extension may contribute a mod (`contributes.mod`): CSS files, a
 * module and desktop window options. The mod runs in the page with the device token, so
 * installing the extension is the approval. Safe mode skips every mod: `BAND_MODS=off` on the hub,
 * the "Turn off mods" switch in Settings > Extensions, or `?mods=off` in the URL.
 */
import {
  type BandModHost,
  EXTENSION_API_VERSION,
  type ExtensionManifest,
  type ModRegion,
} from "@band-app/plugin-api";
import * as React from "react";
import { useEffect, useSyncExternalStore } from "react";
import {
  clearMods,
  recordModError,
  registerOverride,
  registerSidebarTransform,
  useDashboardStore,
  useRepos,
} from "@/dashboard";
import { type ExtensionList, useExtensions } from "./extensions";
import { hubUrl } from "./hub-config";

const OFF_KEY = "band:mods-off";
const OFF_EVENT = "band:mods-off-changed";

export function modsTurnedOff(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setModsTurnedOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(OFF_KEY, "1");
    else localStorage.removeItem(OFF_KEY);
  } catch {
    // storage unavailable: the switch holds for this page only
  }
  window.dispatchEvent(new Event(OFF_EVENT));
}

export function useModsTurnedOff(): boolean {
  return useSyncExternalStore(
    (fn) => {
      window.addEventListener(OFF_EVENT, fn);
      return () => window.removeEventListener(OFF_EVENT, fn);
    },
    modsTurnedOff,
    () => false,
  );
}

function buildHost(extensionId: string): BandModHost {
  return {
    React,
    extensionApi: EXTENSION_API_VERSION,
    extensionId,
    override: (region: ModRegion, render) =>
      registerOverride(extensionId, region, render as Parameters<typeof registerOverride>[2]),
    transformSidebarItems: (fn) => registerSidebarTransform(extensionId, fn),
    hooks: {
      useAgentStatus: (worktreeId) =>
        useDashboardStore((s) => s.statuses.get(worktreeId)?.agent?.status),
      useBranchStatus: (worktreeId) =>
        useDashboardStore((s) => s.branchStatuses.get(worktreeId)) as
          | Record<string, unknown>
          | undefined,
      useWorktrees: () => {
        const { repos } = useRepos();
        return repos.flatMap((r) =>
          r.worktrees.map((w) => ({
            repoName: r.name,
            name: w.name,
            branch: w.branch,
            hostId: w.hostId,
          })),
        );
      },
    },
  };
}

const modUrl = (id: string, file: string) =>
  hubUrl(`/ext/${encodeURIComponent(id)}/${file.split("/").map(encodeURIComponent).join("/")}`);

async function applyMod(
  manifest: ExtensionManifest,
  links: HTMLLinkElement[],
  isCancelled: () => boolean,
): Promise<void> {
  const mod = manifest.contributes.mod;
  if (!mod || isCancelled()) return;
  for (const css of mod.css) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${modUrl(manifest.id, css)}?v=${encodeURIComponent(manifest.version)}`;
    link.dataset.bandMod = manifest.id;
    document.head.appendChild(link);
    links.push(link);
  }
  if (!mod.module) return;
  try {
    const url = `${modUrl(manifest.id, mod.module)}?v=${encodeURIComponent(manifest.version)}`;
    const loaded = await import(/* @vite-ignore */ url);
    if (isCancelled()) return;
    if (typeof loaded.default === "function") await loaded.default(buildHost(manifest.id));
  } catch (err) {
    recordModError({
      extensionId: manifest.id,
      region: "load",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Loads the mods of the installed extensions, in install order, unless safe mode is on. */
export function ModsLoader(): null {
  const { list } = useExtensions();
  const off = useModsTurnedOff();
  const hubOff = list?.modsOff === true;
  const key = list
    ? JSON.stringify(list.extensions.map((e) => [e.id, e.version, e.contributes.mod]))
    : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the mod manifests in `list`
  useEffect(() => {
    if (!list || off || hubOff) return;
    const links: HTMLLinkElement[] = [];
    let cancelled = false;
    void (async () => {
      for (const ext of (list as ExtensionList).extensions) {
        if (cancelled) return;
        if (ext.contributes.mod) await applyMod(ext, links, () => cancelled);
      }
    })();
    return () => {
      cancelled = true;
      for (const l of links) l.remove();
      clearMods();
    };
  }, [key, off, hubOff]);
  return null;
}

/** Reads `?mods=off` once at startup so a broken mod can be skipped without the UI. */
export function applyModsUrlParam(): void {
  try {
    if (new URLSearchParams(window.location.search).get("mods") === "off") setModsTurnedOff(true);
  } catch {
    // no URL to read
  }
}
