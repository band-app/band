import { useCallback, useEffect, useState } from "react";

/**
 * Per-device, opt-in flags for unstable features. Stored in localStorage so
 * they survive reloads but don't sync across devices — matches the spirit of
 * "experimental: turn on if you want to try it."
 */
export const EXPERIMENTAL_FLAG_KEYS = {
  gitGraph: "band.experimental.git-graph",
} as const;

type FlagKey = (typeof EXPERIMENTAL_FLAG_KEYS)[keyof typeof EXPERIMENTAL_FLAG_KEYS];

function readFlag(key: FlagKey): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(key) === "true";
}

function writeFlag(key: FlagKey, value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value ? "true" : "false");
  window.dispatchEvent(new CustomEvent("band:experimental-flag-change", { detail: { key } }));
}

function useExperimentalFlag(key: FlagKey): [boolean, (value: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => readFlag(key));

  useEffect(() => {
    const sync = (e: Event) => {
      if (e instanceof CustomEvent && e.detail?.key !== key) return;
      setEnabled(readFlag(key));
    };
    window.addEventListener("band:experimental-flag-change", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("band:experimental-flag-change", sync);
      window.removeEventListener("storage", sync);
    };
  }, [key]);

  const set = useCallback(
    (value: boolean) => {
      writeFlag(key, value);
      setEnabled(value);
    },
    [key],
  );

  return [enabled, set];
}

export function useExperimentalGitGraph(): [boolean, (value: boolean) => void] {
  return useExperimentalFlag(EXPERIMENTAL_FLAG_KEYS.gitGraph);
}
