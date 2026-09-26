import { useEffect } from "react";
import { pruneBrowserProfileData } from "../lib/chrome-import";
import { isDesktop } from "../lib/is-desktop";
import { trpc } from "../lib/trpc-client";

// Once per renderer lifetime, not per mount.
let swept = false;

/**
 * Desktop-only. A profile deleted from Settings in a plain browser tab (or
 * over the tunnel) can't wipe its cookies, which live in this Mac's
 * Electron partitions. On startup, ask the desktop to wipe every profile
 * partition the server no longer knows. Only runs after a successful list,
 * so a failed fetch never wipes a live profile.
 */
export function BrowserProfileSweeper() {
  useEffect(() => {
    if (!isDesktop || swept) return;
    swept = true;
    trpc.browserProfiles.list
      .query()
      .then(({ profiles }) => pruneBrowserProfileData(profiles.map((p) => p.id)))
      .catch((err) => console.error("Failed to prune deleted browser profiles:", err));
  }, []);
  return null;
}
