import { Globe, RotateCw } from "lucide-react";

/**
 * Shape of the `browser-load-error` IPC payload. Mirrors
 * `BrowserLoadErrorPayload` in `apps/desktop/src/browser/load-error.ts`
 * — duplicated here so the renderer doesn't need to import from the
 * desktop package.
 */
export interface LoadErrorState {
  url: string;
  errorCode: number;
  errorName: string;
  headline: string;
  description: string;
}

/**
 * Chrome-style "This site can't be reached" page for the Band
 * browser pane. Companion to `CertErrorInterstitial` — the cert
 * variant has a Proceed-with-exception flow; this one just gives
 * the user a Reload + Back pair, the same actions Chrome ships for
 * generic navigation failures (DNS / refused / timeout / …).
 *
 * Like the cert interstitial: rendered as an absolute overlay
 * inside the WebContentsView's placeholder div. The host panel
 * separately drives `browser_hide` on the WebContentsView while
 * the page is up, so the OS-level compositor layer doesn't paint
 * over the React DOM.
 */
export function LoadErrorPage({
  state,
  onRetry,
  onBack,
}: {
  state: LoadErrorState;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center overflow-auto bg-background p-8"
      data-testid="load-error-page"
    >
      <div className="flex w-full max-w-xl flex-col gap-6">
        <div className="flex flex-col items-start gap-3">
          <Globe className="size-12 text-muted-foreground" aria-hidden />
          <h1 className="text-2xl font-semibold text-foreground">{state.headline}</h1>
          <p className="break-all text-sm text-muted-foreground">{state.url}</p>
          <p className="text-sm text-foreground/80">{state.description}</p>
          <code className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
            {state.errorName}
          </code>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            data-testid="load-error-retry"
          >
            <RotateCw className="size-4" aria-hidden />
            Reload
          </button>
          <button
            type="button"
            onClick={onBack}
            className="rounded border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            data-testid="load-error-back"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
