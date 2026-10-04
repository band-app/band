/**
 * The page the main window shows when the saved remote hub does not answer at
 * launch, and the two actions it offers. The page is a `data:` URL whose
 * buttons are links to `band-action://` URLs; the window's navigation handler
 * turns those into actions (`window.ts`). No Electron imports, so tests need
 * none.
 */

export type HubFallbackAction = "retry" | "use-local";

const PAGE_PREFIX = "data:text/html;charset=utf-8,";
const RETRY_URL = "band-action://hub-retry";
const USE_LOCAL_URL = "band-action://hub-use-local";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The `data:` URL of the "hub unreachable" page. `hubUrl` and `reason` are escaped. */
export function hubUnreachableUrl(hubUrl: string, reason: string): string {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Band</title>
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #111; color: #eee; font: 14px -apple-system, system-ui, sans-serif; }
  main { max-width: 480px; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { margin: 8px 0; color: #bbb; line-height: 1.5; }
  code { color: #eee; }
  .actions { margin-top: 20px; display: flex; gap: 8px; }
  a { padding: 6px 14px; border-radius: 6px; border: 1px solid #555; color: #eee; text-decoration: none; }
  a.primary { background: #3b82f6; border-color: #3b82f6; }
</style></head><body><main>
<h1 data-testid="hub-unreachable__title">Can't reach your hub</h1>
<p>Band is set to use the hub at <code>${escapeHtml(hubUrl)}</code>.</p>
<p data-testid="hub-unreachable__reason">${escapeHtml(reason)}</p>
<div class="actions">
  <a class="primary" href="${RETRY_URL}" data-testid="hub-unreachable__retry">Retry</a>
  <a href="${USE_LOCAL_URL}" data-testid="hub-unreachable__use-local">Use local</a>
</div>
</main></body></html>`;
  return `${PAGE_PREFIX}${encodeURIComponent(html)}`;
}

/**
 * The action a navigation asks for, or null. Only the page this module built
 * can ask: a click from any other page, such as the bundled UI, is not one.
 */
export function hubFallbackAction(currentUrl: string, targetUrl: string): HubFallbackAction | null {
  if (!currentUrl.startsWith(PAGE_PREFIX)) return null;
  if (targetUrl === RETRY_URL) return "retry";
  if (targetUrl === USE_LOCAL_URL) return "use-local";
  return null;
}
