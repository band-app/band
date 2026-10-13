export const HTML_PREVIEW_EVENT = "band:preview-html";

/** Asks one browser tab to load a URL. Loading the URL it already shows reloads it. */
export const BROWSER_LOAD_EVENT = "band:browser-load";

export interface BrowserLoadDetail {
  browserId: string;
  url: string;
}

export interface HtmlPreviewDetail {
  worktreeId: string;
  path: string;
}

export function isHtmlFile(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** Ask the worktree's center dockview to show `path` in a Band browser tab. */
export function previewHtmlInBrowser(detail: HtmlPreviewDetail): void {
  window.dispatchEvent(new CustomEvent(HTML_PREVIEW_EVENT, { detail }));
}

/** Whether a tab URL is a preview URL for `path` in `worktreeId`, whatever its grant. */
export function isPreviewUrlFor(url: string, worktreeId: string, path: string): boolean {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return (
    url.includes(`/api/worktree-preview/${encodeURIComponent(worktreeId)}/`) &&
    url.split("?")[0].endsWith(`/${encodedPath}`)
  );
}
