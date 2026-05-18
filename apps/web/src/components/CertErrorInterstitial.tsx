import { AlertTriangle, ShieldAlert } from "lucide-react";
import { useState } from "react";

/**
 * Shape of the `browser-cert-error` IPC payload. Mirrors
 * `BrowserCertErrorPayload` in `apps/desktop/src/browser/cert-error.ts`
 * — duplicated here so the renderer doesn't need to import from the
 * desktop package (which isn't a runtime dep of `@band-app/web`).
 */
export interface CertErrorState {
  url: string;
  host: string;
  errorCode: string;
  errorDescription: string;
  fingerprint: string;
  subjectName?: string;
  issuerName?: string;
  validStart?: number;
  validExpiry?: number;
}

/**
 * Chrome-style "Your connection is not private" interstitial for the
 * Band browser pane (issue #444).
 *
 * Layout follows Chrome's full-bleed warning page: red shield icon,
 * one-line headline naming the host, the specific error explanation,
 * and a two-step Advanced → Proceed flow. The "Proceed" link is
 * hidden until the user expands the Advanced section, so it can't be
 * mis-clicked in the same way that Chrome's "thisisunsafe" keystroke
 * gates the workflow.
 *
 * The component is presentational — `onProceed` and `onBack` are
 * supplied by the host panel which knows whether to call
 * `browser_proceed_with_cert_error` (record exception + reload) or
 * `browser_clear_cert_error` + navigate-away.
 */
export function CertErrorInterstitial({
  state,
  onProceed,
  onBack,
}: {
  state: CertErrorState;
  onProceed: () => void;
  onBack: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div
      // Absolute over the placeholder area + opaque background so the
      // native `WebContentsView` (which would normally OS-composite on
      // top) cannot bleed through. The host panel also calls
      // `browser_hide` while the interstitial is visible so the
      // WebContentsView is parked off-screen.
      className="absolute inset-0 z-50 flex items-center justify-center overflow-auto bg-background p-8"
      data-testid="cert-error-interstitial"
    >
      <div className="flex w-full max-w-xl flex-col gap-6">
        <div className="flex flex-col items-start gap-3">
          <ShieldAlert className="size-12 text-destructive" aria-hidden />
          <h1 className="text-2xl font-semibold text-foreground">Your connection is not private</h1>
          <p className="text-sm text-muted-foreground">
            Attackers might be trying to steal your information from{" "}
            <span className="font-medium text-foreground">{state.host || state.url}</span> (for
            example, passwords, messages, or credit cards).
          </p>
          <p className="text-sm text-foreground/80">{state.errorDescription}</p>
          <code className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
            {state.errorCode}
          </code>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            data-testid="cert-error-back"
          >
            Back to safety
          </button>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="rounded border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            aria-expanded={showAdvanced}
            data-testid="cert-error-advanced"
          >
            {showAdvanced ? "Hide details" : "Advanced"}
          </button>
        </div>

        {showAdvanced ? (
          <div className="flex flex-col gap-3 rounded border border-border bg-muted/40 p-4 text-sm">
            <div className="flex items-start gap-2 text-foreground/80">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <p>
                This server could not prove that it is{" "}
                <span className="font-medium text-foreground">{state.host || "this site"}</span>
                {" — "}its security certificate is not trusted by your computer. This may be caused
                by a misconfiguration or an attacker intercepting your connection.
              </p>
            </div>

            <dl className="grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-[auto_1fr]">
              {state.subjectName ? (
                <>
                  <dt className="font-medium text-foreground/70">Subject</dt>
                  <dd className="break-all">{state.subjectName}</dd>
                </>
              ) : null}
              {state.issuerName ? (
                <>
                  <dt className="font-medium text-foreground/70">Issuer</dt>
                  <dd className="break-all">{state.issuerName}</dd>
                </>
              ) : null}
              <dt className="font-medium text-foreground/70">Fingerprint</dt>
              <dd className="break-all font-mono text-[10px]">{state.fingerprint}</dd>
              {typeof state.validStart === "number" ? (
                <>
                  <dt className="font-medium text-foreground/70">Valid from</dt>
                  <dd>{formatCertDate(state.validStart)}</dd>
                </>
              ) : null}
              {typeof state.validExpiry === "number" ? (
                <>
                  <dt className="font-medium text-foreground/70">Valid until</dt>
                  <dd>{formatCertDate(state.validExpiry)}</dd>
                </>
              ) : null}
            </dl>

            <button
              type="button"
              onClick={onProceed}
              className="self-start text-sm font-medium text-destructive underline-offset-4 hover:underline"
              data-testid="cert-error-proceed"
            >
              Proceed to {state.host || "this site"} (unsafe)
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Render a "Not Secure" pill for the address bar of any host the
 * user has overridden a cert error for in this session. Mirrors
 * Chrome's red warning lozenge so the unsafe state is visible
 * whenever the user is on that origin.
 */
export function NotSecureBadge() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive"
      title="The certificate for this site was overridden for the current session. Use with caution."
      data-testid="cert-not-secure-badge"
    >
      <AlertTriangle className="size-3" aria-hidden />
      Not secure
    </span>
  );
}

/**
 * Chromium reports certificate validity as seconds-since-epoch but
 * some Electron builds (and the mock cert in the integration test)
 * occasionally surface them in milliseconds. Detect by magnitude —
 * anything past year 2300 in seconds is almost certainly ms — and
 * format in the user's locale.
 */
function formatCertDate(value: number): string {
  // 1e10 seconds = year 2286; anything bigger has to be ms.
  const ms = value > 1e10 ? value : value * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}
