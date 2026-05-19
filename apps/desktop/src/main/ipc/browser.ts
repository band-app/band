/**
 * Thin IPC handler glue for the `browser_*` commands.
 * Delegates to `BrowserViewManager` (in `apps/desktop/src/browser/view-manager.ts`),
 * which holds the `WebContentsView` LRU and emits change events.
 */

import type { BrowserViewManager } from "../../browser/view-manager.js";
import type {
  BrowserBoundsArgs,
  BrowserCreateArgs,
  BrowserEnsureArgs,
  BrowserEvalArgs,
  BrowserFindInPageArgs,
  BrowserKeyArg,
  BrowserNavigateArgs,
  BrowserStopFindInPageArgs,
  BrowserZoomArgs,
} from "../../shared/types.js";

export interface BrowserIpcContext {
  manager: BrowserViewManager;
}

export const browserHandlers = {
  create: (ctx: BrowserIpcContext, args: BrowserCreateArgs): void => ctx.manager.create(args),
  navigate: (ctx: BrowserIpcContext, args: BrowserNavigateArgs): void => ctx.manager.navigate(args),
  setBounds: (ctx: BrowserIpcContext, args: BrowserBoundsArgs): void => ctx.manager.setBounds(args),
  show: (ctx: BrowserIpcContext, args: BrowserKeyArg): void => ctx.manager.show(args),
  hide: (ctx: BrowserIpcContext, args: BrowserKeyArg): void => ctx.manager.hide(args),
  reload: (ctx: BrowserIpcContext, args: BrowserKeyArg): void => ctx.manager.reload(args),
  goBack: (ctx: BrowserIpcContext, args: BrowserKeyArg): void => ctx.manager.goBack(args),
  goForward: (ctx: BrowserIpcContext, args: BrowserKeyArg): void => ctx.manager.goForward(args),
  evalJs: (ctx: BrowserIpcContext, args: BrowserEvalArgs): Promise<void> =>
    ctx.manager.evalJs(args),
  destroy: (ctx: BrowserIpcContext, args: BrowserKeyArg): void => ctx.manager.destroy(args),
  hideAll: (ctx: BrowserIpcContext): void => ctx.manager.hideAll(),
  showAll: (ctx: BrowserIpcContext): void => ctx.manager.showAll(),
  ensure: (ctx: BrowserIpcContext, args: BrowserEnsureArgs): void => ctx.manager.ensure(args),
  getCdpTarget: (ctx: BrowserIpcContext, args: BrowserKeyArg): Promise<string> =>
    ctx.manager.getCdpTargetId(args),
  findInPage: (ctx: BrowserIpcContext, args: BrowserFindInPageArgs): number | undefined =>
    ctx.manager.findInPage(args),
  stopFindInPage: (ctx: BrowserIpcContext, args: BrowserStopFindInPageArgs): void =>
    ctx.manager.stopFindInPage(args),
  capturePage: (ctx: BrowserIpcContext, args: BrowserKeyArg): Promise<string | null> =>
    ctx.manager.capturePage(args),
  pauseMedia: (ctx: BrowserIpcContext, args: BrowserKeyArg): Promise<void> =>
    ctx.manager.pauseMedia(args),
  resumeMedia: (ctx: BrowserIpcContext, args: BrowserKeyArg): Promise<void> =>
    ctx.manager.resumeMedia(args),
  zoom: (ctx: BrowserIpcContext, args: BrowserZoomArgs): void => ctx.manager.zoom(args),
  toggleDevTools: (ctx: BrowserIpcContext, args: BrowserKeyArg): void =>
    ctx.manager.toggleDevTools(args),
  // Cert / load error pages are painted INSIDE the WebContentsView
  // via a `data:` URI (issue #444). The user's button clicks become
  // `band-action://…` navigations intercepted by the view manager,
  // so the only renderer-facing surface is this catch-up call: the
  // dashboard chrome reads it on mount to paint the "Not Secure"
  // badge for any hosts the user already proceeded to in this
  // session. See `browser/error-html.ts`.
  getOverriddenHosts: (ctx: BrowserIpcContext): string[] => ctx.manager.getOverriddenHosts(),
};
