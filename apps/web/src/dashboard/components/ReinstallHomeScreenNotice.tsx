import { Button } from "@band-app/ui";
import { CircleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

const DISMISSED_KEY = "band:reinstall-home-screen-dismissed";

/** The top safe-area inset in CSS px, read from a probe element because
 *  `env()` has no JS API. */
function readSafeAreaInsetTop(): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top)";
  document.body.appendChild(probe);
  const inset = Number.parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return inset;
}

/** An iOS home-screen app still running with the translucent status bar
 *  Band asked for before v0.33. iOS reads `apple-mobile-web-app-status-bar-style`
 *  only when the app is added, so those installs keep it: on iOS 26 the page
 *  then draws under the status bar and its window stops one status bar short of
 *  the bottom edge (WebKit bug 301108). With the current opaque `black` style
 *  the page starts below the status bar, so its top inset is 0. */
function isStaleHomeScreenInstall(): boolean {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone && readSafeAreaInsetTop() > 0;
}

/**
 * Tells the user to remove Band from the Home Screen and add it again when the
 * installed app still uses the old status bar style. No page CSS can reach the
 * strip that style leaves above the home indicator, so re-adding is the fix.
 * Renders nothing in a browser tab, on the desktop app, or once dismissed.
 */
export function ReinstallHomeScreenNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISSED_KEY)) return;
    } catch {}
    // A stale install reports no top inset in landscape, so check again when
    // the device turns.
    const check = () => {
      if (isStaleHomeScreenInstall()) setShow(true);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {}
  };

  return (
    <output
      aria-live="polite"
      data-testid="reinstall-home-screen-notice"
      className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] left-4 z-50 block rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg sm:left-auto sm:w-80"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={dismiss}
        className="absolute top-2 right-2 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <X className="size-3.5" />
      </button>
      <div className="flex gap-2.5 pr-6">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0">
          <p className="font-medium">Add Band to your Home Screen again</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            This copy was added with an older setup, so it doesn't fit the screen. Remove it from
            the Home Screen, then open Band in Safari and choose Share, Add to Home Screen.
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="ghost" size="xs" onClick={dismiss}>
          Got it
        </Button>
      </div>
    </output>
  );
}
