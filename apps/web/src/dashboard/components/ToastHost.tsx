import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { CircleAlert, Info } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { subscribeToastObstructions, toastObstructions } from "../../lib/toast-obstructions";
import { INFO_NOTICE_MS, type Notice } from "../stores/dashboard-store";
import { useDashboardStore } from "../stores/index";
import { ReinstallHomeScreenNotice } from "./ReinstallHomeScreenNotice";
import { ToastCard } from "./ToastCard";
import { UpdateToast } from "./UpdateToast";

/** Space between the stack and an element it moves above, in CSS px. */
const OBSTRUCTION_GAP = 8;

/**
 * The one place toasts render: a column in the bottom-right corner (full
 * width minus the gutters on a phone) holding the app update toast, the Home
 * Screen notice and the dashboard's notices, stacked upwards in that order.
 * It sits above the home-indicator inset, and above the chat composer, the
 * mobile terminal key bar or the dashboard action bar when it would cover
 * them (`lib/toast-obstructions.ts`).
 */
export function ToastHost() {
  const hostRef = useRef<HTMLElement>(null);
  const bottom = useObstructionBottom(hostRef);
  const notices = useDashboardStore((s) => s.notices);

  return (
    <section
      ref={hostRef}
      aria-label="Notifications"
      data-testid="toast-host"
      style={bottom === null ? undefined : { bottom }}
      className="pointer-events-none fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] left-4 z-50 flex flex-col-reverse gap-2 sm:left-auto sm:w-80"
    >
      <UpdateToast />
      <ReinstallHomeScreenNotice />
      {notices.map((notice) => (
        <NoticeToast key={notice.id} notice={notice} />
      ))}
    </section>
  );
}

function NoticeToast({ notice }: { notice: Notice }) {
  const dismissNotice = useDashboardStore((s) => s.dismissNotice);
  const [showDetails, setShowDetails] = useState(false);
  const isError = notice.tone === "error";

  useEffect(() => {
    if (isError) return;
    const timer = setTimeout(() => dismissNotice(notice.id), INFO_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [isError, notice.id, dismissNotice]);

  return (
    <ToastCard
      testId="toast-host__notice"
      tone={notice.tone}
      onClose={() => dismissNotice(notice.id)}
    >
      <div className="flex gap-2.5 pr-6">
        {isError ? (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : (
          <Info className="mt-0.5 size-4 shrink-0 text-blue-500" />
        )}
        <p className="min-w-0 line-clamp-4 break-words">{notice.message}</p>
      </div>
      {isError && (
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" size="xs" onClick={() => setShowDetails(true)}>
            Details
          </Button>
        </div>
      )}
      <Dialog open={showDetails} onOpenChange={setShowDetails}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Error</DialogTitle>
            <DialogDescription>Click the error text to select it.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-sm select-all">
            {notice.message}
          </pre>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigator.clipboard.writeText(notice.message)}
            >
              Copy
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setShowDetails(false);
                dismissNotice(notice.id);
              }}
            >
              Dismiss
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ToastCard>
  );
}

/**
 * The stack's `bottom` in CSS px when a registered obstruction in the lower
 * half of the screen overlaps its column, or `null` to keep the default
 * bottom-right position. Measures again when an obstruction registers,
 * resizes or appears (a hidden workspace becoming the active one), and when
 * the window or the on-screen keyboard changes size.
 */
function useObstructionBottom(hostRef: RefObject<HTMLElement | null>): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  const measureRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const column = host.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      let top = Number.POSITIVE_INFINITY;
      for (const el of toastObstructions()) {
        // Skips elements in a hidden workspace (`visibility` and
        // `content-visibility: hidden`) and in an inactive dock tab.
        if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right <= column.left || rect.left >= column.right) continue;
        if (rect.top < viewportHeight / 2 || rect.top >= viewportHeight) continue;
        top = Math.min(top, rect.top);
      }
      const next = Number.isFinite(top) ? viewportHeight - top + OBSTRUCTION_GAP : null;
      setBottom((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measureRef.current = schedule;

    const resizeObserver = new ResizeObserver(schedule);
    const observeAll = () => {
      resizeObserver.disconnect();
      for (const el of toastObstructions()) resizeObserver.observe(el);
      schedule();
    };
    observeAll();
    const unsubscribe = subscribeToastObstructions(observeAll);
    const viewport = window.visualViewport;
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      unsubscribe();
      resizeObserver.disconnect();
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      measureRef.current = () => {};
    };
  }, [hostRef]);

  // Switching workspaces swaps `visibility`, which changes no element's size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on each switch
  useEffect(() => {
    measureRef.current();
  }, [activeWorkspaceId]);

  return bottom;
}
