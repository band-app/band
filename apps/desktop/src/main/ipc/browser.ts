/**
 * Thin IPC handler glue for the 12 `browser_*` commands.
 * Delegates to `BrowserViewManager` (in `apps/desktop/src/browser/view-manager.ts`),
 * which holds the `WebContentsView` LRU and emits change events.
 */

import type { BrowserCertErrorPayload } from "../../browser/cert-error.js";
import type { BrowserViewManager } from "../../browser/view-manager.js";
import type {
  BrowserBoundsArgs,
  BrowserCreateArgs,
  BrowserEnsureArgs,
  BrowserEvalArgs,
  BrowserFindInPageArgs,
  BrowserKeyArg,
  BrowserNavigateArgs,
  BrowserProceedWithCertErrorArgs,
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
  proceedWithCertError: (ctx: BrowserIpcContext, args: BrowserProceedWithCertErrorArgs): void =>
    ctx.manager.proceedWithCertError(args),
  getCertErrorForView: (
    ctx: BrowserIpcContext,
    args: BrowserKeyArg,
  ): BrowserCertErrorPayload | null => ctx.manager.getCertErrorForView(args),
  clearCertError: (ctx: BrowserIpcContext, args: BrowserKeyArg): void =>
    ctx.manager.clearCertError(args),
};
