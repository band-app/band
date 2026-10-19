import type { Disposable, LayoutApi } from "./model";

/**
 * Forwards the title of the layout's active panel to `push`: once now, again
 * whenever that panel's title changes, and again when another panel becomes
 * active. The initial call matters because a lone pane is activated before any
 * listener exists, so no active-panel event ever fires for it.
 */
export function trackActivePanelTitle(api: LayoutApi, push: () => void): Disposable {
  let titleSub: Disposable | undefined;
  const attach = () => {
    titleSub?.dispose();
    titleSub = api.activePanel?.api.onDidTitleChange(push);
    push();
  };
  const activeSub = api.onDidActivePanelChange(attach);
  attach();
  return {
    dispose() {
      activeSub.dispose();
      titleSub?.dispose();
    },
  };
}
