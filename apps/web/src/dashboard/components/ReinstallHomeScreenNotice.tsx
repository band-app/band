import { Button } from "@band-app/ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { ToastCard } from "./ToastCard";

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

/** Whether this is an iOS home-screen app. One that reports a top inset still
 *  runs with the translucent status bar Band asked for before #681 (v0.33.0).
 *  iOS reads `apple-mobile-web-app-status-bar-style` only when the app is
 *  added, so those installs keep it: on iOS 26 the page then draws under the
 *  status bar and its window stops one status bar short of the bottom edge
 *  (WebKit bug 301108). With the current opaque `black` style the page starts
 *  below the status bar, so its top inset is 0. */
function isIosHomeScreenApp(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
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
    if (!isIosHomeScreenApp()) return;
    try {
      if (localStorage.getItem(DISMISSED_KEY)) return;
    } catch {}
    // A stale install reports no top inset in landscape, so check again when
    // the device turns. Stop once found: the answer can't change, and a
    // later resize must not bring back a dismissed notice.
    const check = () => {
      if (readSafeAreaInsetTop() <= 0) return;
      setShow(true);
      window.removeEventListener("resize", check);
    };
    window.addEventListener("resize", check);
    check();
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
    <ToastCard testId="reinstall-home-screen-notice" onClose={dismiss}>
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
    </ToastCard>
  );
}
