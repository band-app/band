import {
  type EnsureViewEvent,
  ensureCdpTargetId,
  isDesktopHostConnected,
  markTargetDestroyed,
  onEnsureView,
  resolveTargetReady,
} from "../infra/browser-host/host-state";

/**
 * Services-tier wrapper around the Browser Host state (the desktop CDP
 * bridge that maps Band's persistent `bandTabId` to a chromium target id).
 *
 * Routers must not import infra directly (per `docs/web-architecture.md`),
 * so this service exists to give `api/browser-host/router.ts` (and any
 * future service-tier orchestration) a stable services-layer surface. The
 * underlying state, constants, and listener registry all live in
 * `server/infra/browser-host/host-state.ts` so the sibling infra adapters
 * (`cdp-proxy.ts`, `cdp-targets.ts`) can talk to them without crossing
 * tiers.
 *
 * Methods are intentionally thin pass-throughs — there's no orchestration
 * beyond delegation today, but a single class makes future changes
 * (logging, metrics, multi-host support) land in one place rather than
 * scattered across module-level functions.
 */
export class BrowserHostService {
  ensureCdpTargetId(bandTabId: string): Promise<string> {
    return ensureCdpTargetId(bandTabId);
  }

  resolveTargetReady(bandTabId: string, cdpTargetId: string): void {
    resolveTargetReady(bandTabId, cdpTargetId);
  }

  markTargetDestroyed(bandTabId: string): void {
    markTargetDestroyed(bandTabId);
  }

  onEnsureView(listener: (event: EnsureViewEvent) => void): () => void {
    return onEnsureView(listener);
  }

  isDesktopHostConnected(): boolean {
    return isDesktopHostConnected();
  }
}

export const browserHostService = new BrowserHostService();

// Re-export the event shape so consumers don't need a separate infra
// import for the type alone.
export type { EnsureViewEvent } from "../infra/browser-host/host-state";
