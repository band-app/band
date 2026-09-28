import type { CheckRun, ChecksReport, ReviewInfo } from "@band-app/plugin-api";
import { useClientPluginHost } from "@band-app/plugin-api/client";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from "@band-app/ui";
import { ChevronDown, ChevronRight, CircleX, ExternalLink, WandSparkles } from "lucide-react";
import { memo, useEffect, useState } from "react";
import {
  CheckStateIcon,
  checkDuration,
  checkElapsed,
  checkStateLabel,
  countChecks,
  isCountingUp,
} from "./check-status";

function fixPrompt(branch: string, review: ReviewInfo | null, failing: CheckRun[]): string {
  const subject = review ? `pull request #${review.number} (${review.title})` : `branch ${branch}`;
  const lines = failing.map((check) => {
    const name = check.workflowName ? `${check.workflowName} / ${check.name}` : check.name;
    return `- ${name}${check.url ? `: ${check.url}` : ""}`;
  });
  return [
    `These CI checks are failing on ${subject}:`,
    ...lines,
    "",
    "Read the failing job logs (for example with `gh run view <run-id> --log-failed`), fix the causes, run the relevant checks locally, and push the fix.",
  ].join("\n");
}

/**
 * The current time, updated every second while `ticking`. One timer for the
 * whole list, so running checks count up together.
 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The failing banner with Fix, the summary row and the list of checks. */
export function ChecksSection({
  workspaceId,
  branch,
  review,
  checks,
  visible,
}: {
  workspaceId: string;
  branch: string;
  review: ReviewInfo | null;
  checks: ChecksReport;
  /** Whether the tab is on screen; the elapsed-time timer only runs then. */
  visible: boolean;
}) {
  const host = useClientPluginHost();
  const [open, setOpen] = useState(true);
  const now = useNow(visible && open && checks.checks.some(isCountingUp));
  const [fixState, setFixState] = useState<"idle" | "starting" | "started">("idle");
  const [fixError, setFixError] = useState<string | null>(null);

  if (checks.checks.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground" data-testid="pr-checks__empty">
        {review
          ? "No checks reported for this pull request."
          : "No GitHub Actions jobs ran on this branch."}
      </p>
    );
  }

  const counts = countChecks(checks.checks);
  const failing = checks.checks.filter((c) => c.state === "failure");

  const startFix = async () => {
    setFixState("starting");
    setFixError(null);
    try {
      await host.startAgent(workspaceId, fixPrompt(branch, review, failing));
      setFixState("started");
    } catch (err) {
      setFixState("idle");
      setFixError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col">
      {failing.length > 0 && (
        <div
          className="flex items-center gap-2 border-b border-border px-3 py-2.5"
          data-testid="pr-checks__failing-banner"
        >
          <CircleX className="size-4 shrink-0 text-red-500" aria-hidden />
          <div className="min-w-0 flex-1">
            <p
              className="text-xs font-semibold"
              data-testid="pr-checks__failing-count"
              data-count={failing.length}
            >
              {failing.length} failing {failing.length === 1 ? "check" : "checks"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {fixError ??
                (fixState === "started"
                  ? "An agent is working on the failures."
                  : "Inspect details or start an AI fix pass.")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void startFix()}
            disabled={fixState === "starting"}
            data-testid="pr-checks__fix"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            <WandSparkles className="size-3.5" aria-hidden />
            Fix
          </button>
        </div>
      )}
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-[11px] text-muted-foreground hover:bg-accent/50"
            data-testid="pr-checks__summary"
            aria-expanded={open}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {counts.passing > 0 && (
              <SummaryCount state="success" count={counts.passing} label="passing" />
            )}
            {counts.failing > 0 && (
              <SummaryCount state="failure" count={counts.failing} label="failing" />
            )}
            {counts.pending > 0 && (
              <SummaryCount state="running" count={counts.pending} label="pending" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul data-testid="pr-checks__list">
            {checks.checks.map((check) => (
              <CheckRow
                key={check.id}
                check={check}
                // Rows without a growing elapsed time keep a stable prop and skip the tick.
                now={isCountingUp(check) ? now : 0}
              />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function SummaryCount({
  state,
  count,
  label,
}: {
  state: "success" | "failure" | "running";
  count: number;
  label: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap"
      data-testid={`pr-checks__summary-${label}`}
      data-count={count}
    >
      <CheckStateIcon
        state={state}
        className={cn("size-3.5", state === "running" && "animate-none")}
      />
      {count} {label}
    </span>
  );
}

const CheckRow = memo(function CheckRow({ check, now }: { check: CheckRun; now: number }) {
  const host = useClientPluginHost();
  const [open, setOpen] = useState(false);
  const duration = checkDuration(check) ?? checkElapsed(check, now);
  return (
    <li
      className="border-b border-border/60"
      data-testid="pr-checks__check"
      data-check-state={check.state}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              aria-expanded={open}
              data-testid="pr-checks__check-toggle"
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <CheckStateIcon state={check.state} />
              <span
                className="min-w-0 flex-1 truncate text-[13px]"
                data-testid="pr-checks__check-name"
              >
                {check.name}
              </span>
              <span
                className="shrink-0 text-[11px] text-muted-foreground"
                data-testid="pr-checks__check-state"
              >
                {checkStateLabel(check.state)}
              </span>
            </button>
          </CollapsibleTrigger>
          {check.url && (
            <a
              href={check.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${check.name} on GitHub`}
              data-testid="pr-checks__check-link"
              onClick={(e) => {
                // Electron would navigate the dashboard's own webview.
                e.preventDefault();
                host.openUrl(check.url as string);
              }}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
        <CollapsibleContent>
          <dl
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pb-2.5 pl-[42px] text-[11px]"
            data-testid="pr-checks__check-details"
          >
            {check.workflowName && (
              <>
                <dt className="text-muted-foreground">Workflow</dt>
                <dd className="min-w-0 truncate">{check.workflowName}</dd>
              </>
            )}
            {check.description && (
              <>
                <dt className="text-muted-foreground">Result</dt>
                <dd className="min-w-0">{check.description}</dd>
              </>
            )}
            {check.startedAt && (
              <>
                <dt className="text-muted-foreground">Started</dt>
                <dd>{new Date(check.startedAt).toLocaleString()}</dd>
              </>
            )}
            {duration && (
              <>
                <dt className="text-muted-foreground">Duration</dt>
                <dd data-testid="pr-checks__check-duration">{duration}</dd>
              </>
            )}
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
});
