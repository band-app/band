import { Button, Popover, PopoverAnchor, PopoverContent } from "@band-app/ui";
import { Check, ExternalLink, Link } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { writeClipboardText } from "../../lib/clipboard";
import { useCapabilities } from "../context";
import type { CIState, PullRequestSummary } from "../types";

/**
 * How the badge colors a PR. An open PR takes its CI state; one with no
 * checks, or only cancelled ones, stays neutral. Merged is violet, as on
 * GitHub, and closed is struck through.
 */
export type PullRequestTone = "failure" | "pending" | "success" | "neutral" | "merged" | "closed";

export function pullRequestTone(pr: PullRequestSummary, ciState: CIState): PullRequestTone {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  switch (ciState) {
    case "failure":
      return "failure";
    case "running":
    case "pending":
      return "pending";
    case "success":
      return "success";
    default:
      return "neutral";
  }
}

// Text, border and a faint fill in one hue, so the number reads as a tag.
const TONE_CLASS: Record<PullRequestTone, string> = {
  failure: "text-red-600 border-red-600/40 bg-red-500/10 dark:text-red-400 dark:border-red-400/40",
  pending:
    "text-yellow-700 border-yellow-600/50 bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-400/40",
  success:
    "text-green-700 border-green-600/40 bg-green-500/10 dark:text-green-400 dark:border-green-400/40",
  neutral: "text-muted-foreground border-border bg-muted/50",
  merged:
    "text-violet-600 border-violet-600/40 bg-violet-500/10 dark:text-violet-400 dark:border-violet-400/40",
  closed: "text-muted-foreground border-border bg-muted/50 line-through",
};

// Compact enough that the tag stays shorter than the row's text line.
const TAG_CLASS = "inline-flex items-center rounded border px-1 py-px leading-none";
const NUMBER_CLASS = `${TAG_CLASS} text-[11px] font-semibold tabular-nums`;

function statusLabel(pr: PullRequestSummary, ciState: CIState): string {
  if (pr.state === "merged") return "Merged";
  if (pr.state === "closed") return "Closed";
  switch (ciState) {
    case "failure":
      return "Checks failing";
    case "running":
      return "Checks running";
    case "pending":
      return "Checks pending";
    case "success":
      return "Checks passed";
    case "cancelled":
      return "Checks cancelled";
    default:
      return "No checks";
  }
}

// Long enough that sweeping the pointer down the sidebar opens nothing.
const OPEN_DELAY_MS = 400;
// Long enough to cross the gap between the badge and the popover.
const CLOSE_DELAY_MS = 200;

interface Props {
  pr: PullRequestSummary;
  ciState: CIState;
  /** Show the worktree's Checks tab. */
  onOpenChecks: () => void;
}

/**
 * The PR number in a worktree row, as a tag colored by CI state. Hovering it, or
 * focusing it from the keyboard, opens a popover with the PR's title and
 * status and actions to open it on GitHub or copy its link; ArrowDown moves
 * focus into the popover. Clicking it shows the Checks tab.
 *
 * Built on Popover rather than HoverCard because HoverCard takes its
 * content's buttons out of the tab order.
 */
export function PullRequestBadge({ pr, ciState, onOpenChecks }: Props) {
  const capabilities = useCapabilities();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set while Escape hands focus back to the badge, so that focus doesn't
  // reopen the popover it just closed.
  const returningFocusRef = useRef(false);

  const cancelTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const setOpenAfter = (next: boolean, delay: number) => {
    cancelTimer();
    timerRef.current = setTimeout(() => setOpen(next), delay);
  };
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const tone = pullRequestTone(pr, ciState);
  const label = `Pull request #${pr.number}: ${statusLabel(pr, ciState)}${pr.isDraft ? ", draft" : ""}`;
  const isInside = (node: EventTarget | null) =>
    node instanceof Node &&
    (contentRef.current?.contains(node) || triggerRef.current?.contains(node));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="worktree-card__pr-badge"
          data-tone={tone}
          className={`shrink-0 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring ${NUMBER_CLASS} ${TONE_CLASS[tone]}`}
          onPointerEnter={(e) => {
            if (e.pointerType !== "touch") setOpenAfter(true, OPEN_DELAY_MS);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "touch") setOpenAfter(false, CLOSE_DELAY_MS);
          }}
          onFocus={(e) => {
            if (returningFocusRef.current) {
              returningFocusRef.current = false;
              return;
            }
            // Keyboard focus only; a click focuses the button too.
            if (!e.currentTarget.matches(":focus-visible")) return;
            cancelTimer();
            setOpen(true);
          }}
          onBlur={(e) => {
            if (!isInside(e.relatedTarget)) setOpenAfter(false, CLOSE_DELAY_MS);
          }}
          onClick={(e) => {
            // The row navigates on click; this click shows the Checks tab.
            e.stopPropagation();
            cancelTimer();
            setOpen(false);
            onOpenChecks();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && open) {
              e.preventDefault();
              contentRef.current?.querySelector<HTMLElement>("button")?.focus();
            }
            // The row and the repo list handle Enter, Space and the arrows.
            if (e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow")) {
              e.stopPropagation();
            }
          }}
        >
          #{pr.number}
        </button>
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        side="right"
        align="start"
        className="w-72 p-3"
        data-testid="pr-popover"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={() => {
          if (contentRef.current?.contains(document.activeElement)) {
            returningFocusRef.current = true;
            triggerRef.current?.focus();
          }
        }}
        onFocusOutside={(e) => {
          if (isInside(e.target)) e.preventDefault();
        }}
        onPointerEnter={cancelTimer}
        onPointerLeave={(e) => {
          if (e.pointerType !== "touch") setOpenAfter(false, CLOSE_DELAY_MS);
        }}
        onBlur={(e) => {
          if (!isInside(e.relatedTarget)) setOpen(false);
        }}
        // React events bubble out of the portal to the worktree row, which
        // would navigate, open its context menu, or move the list selection.
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-xs">
          <span
            data-testid="pr-popover__number"
            data-tone={tone}
            className={`${NUMBER_CLASS} ${TONE_CLASS[tone]}`}
          >
            #{pr.number}
          </span>
          {pr.isDraft && (
            <span
              data-testid="pr-popover__draft"
              className={`${TAG_CLASS} border-border text-[10px] font-medium text-muted-foreground`}
            >
              Draft
            </span>
          )}
          <span
            data-testid="pr-popover__status"
            data-status={pr.state === "open" ? ciState : pr.state}
            className="text-muted-foreground"
          >
            {statusLabel(pr, ciState)}
          </span>
        </div>
        <p
          data-testid="pr-popover__title"
          className="mt-1.5 line-clamp-3 break-words text-[13px] font-medium text-foreground"
        >
          {pr.title}
        </p>
        <div className="mt-2 -ml-1.5 flex items-center gap-1">
          {capabilities.openUrl && (
            <Button
              variant="ghost"
              size="xs"
              data-testid="pr-popover__open"
              onClick={() => {
                setOpen(false);
                void capabilities.openUrl?.(pr.url);
              }}
            >
              <ExternalLink />
              Open on GitHub
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            data-testid="pr-popover__copy"
            data-copied={copied || undefined}
            onClick={() => {
              void writeClipboardText(pr.url).then((ok) => setCopied(ok));
            }}
          >
            {copied ? <Check /> : <Link />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
