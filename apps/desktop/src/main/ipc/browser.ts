/**
 * Thin IPC handler glue for the `browser_*` commands.
 * Delegates to `BrowserGuestManager` (in `apps/desktop/src/browser/guest-manager.ts`).
 * Navigation, find-in-page and zoom need no IPC: the renderer calls them on
 * its `<webview>` element.
 */

import type { BrowserGuestManager } from "../../browser/guest-manager.js";
import type {
  BrowserEnsureArgs,
  BrowserKeyArg,
  BrowserOpenDevToolsArgs,
  BrowserRegisterGuestArgs,
  BrowserRegisterGuestResult,
} from "../../shared/types.js";

export interface BrowserIpcContext {
  manager: BrowserGuestManager;
}

export const browserHandlers = {
  registerGuest: (
    ctx: BrowserIpcContext,
    args: BrowserRegisterGuestArgs,
  ): BrowserRegisterGuestResult => ctx.manager.registerGuest(args),
  ensure: (ctx: BrowserIpcContext, args: BrowserEnsureArgs): void => ctx.manager.ensure(args),
  getCdpTarget: (ctx: BrowserIpcContext, args: BrowserKeyArg): Promise<string> =>
    ctx.manager.getCdpTargetId(args),
  openDevTools: (ctx: BrowserIpcContext, args: BrowserOpenDevToolsArgs): boolean =>
    ctx.manager.openDevTools(args),
  closeDevTools: (ctx: BrowserIpcContext, args: BrowserKeyArg): void =>
    ctx.manager.closeDevTools(args),
  // Cert / load error pages are painted INSIDE the guest via a `data:`
  // URI (issue #444). The user's button clicks become `band-action://…`
  // navigations intercepted by the guest manager, so the only
  // renderer-facing surface is this catch-up call: the dashboard chrome
  // reads it on mount to paint the "Not Secure" badge for any hosts the
  // user already proceeded to in this session. See `browser/error-html.ts`.
  getOverriddenHosts: (ctx: BrowserIpcContext): string[] => ctx.manager.getOverriddenHosts(),
};
