/**
 * Dependency-inversion seam for CDP to a browser on a remote worker (plan
 * step 7.3). `cdp-proxy.ts` is infra and cannot reach the host registry, so
 * `services/browser-service.ts` registers the opener at module load.
 */

import type { BrowserCdp } from "@band-app/host-api";

/** Resolves to null when the worktree is local, so the desktop's own CDP path applies. */
type RemoteCdpOpener = (worktreeId: string) => Promise<BrowserCdp | null>;

let current: RemoteCdpOpener = async () => null;

export function setRemoteCdpOpener(opener: RemoteCdpOpener): void {
  current = opener;
}

export function openRemoteCdp(worktreeId: string): Promise<BrowserCdp | null> {
  return current(worktreeId);
}
