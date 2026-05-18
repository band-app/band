import { AlertTriangle } from "lucide-react";

/**
 * Address-bar pill flagging the current origin as having an
 * overridden TLS certificate (issue #444). Mirrors Chrome's red
 * "Not Secure" lozenge so the unsafe state stays visible while the
 * user is browsing a site whose cert they accepted.
 *
 * Driven by `useOverriddenHosts`. The interstitial itself lives
 * inside the WebContentsView (see
 * `apps/desktop/src/browser/error-html.ts`), so this is the only
 * piece of cert-error UI that the dashboard renderer still owns.
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
