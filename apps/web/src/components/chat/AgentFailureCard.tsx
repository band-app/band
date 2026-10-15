// The card a chat shows when its agent fails: what happened, what happens
// next, and the raw output behind "Show details".

import {
  type AgentFailure,
  describeFailure,
  failureTone,
  filterOutput,
} from "@band-app/shared/agent-failure";
import { Button, cn } from "@band-app/ui";
import { ChevronDown, ChevronRight, OctagonAlert, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { writeClipboardText } from "../../lib/clipboard";

function hostLabel(host: string): string {
  return host === "" || host === "local" ? "this hub" : host;
}

function formatAt(at: number): string {
  return at > 0 ? new Date(at).toLocaleTimeString() : "";
}

function facts(f: AgentFailure): [string, string][] {
  const rows: [string, string][] = [];
  if (f.signal) rows.push(["Exit signal", `${f.signal}${f.exitCode === null ? " (no code)" : ""}`]);
  else if (f.exitCode !== null) rows.push(["Exit code", String(f.exitCode)]);
  if (f.host) rows.push(["Host", f.host]);
  if (f.agent) rows.push(["Agent", f.agent]);
  if (f.sessionId) rows.push(["Session", f.sessionId]);
  if (f.at > 0) {
    const into = f.turnMs !== undefined ? `, ${Math.round(f.turnMs / 1000)} s into the turn` : "";
    rows.push(["When", `${formatAt(f.at)}${into}`]);
  }
  return rows;
}

/** Facts plus the whole stderr tail, for a bug report. */
export function failureReport(f: AgentFailure): string {
  const { headline, line } = describeFailure(f, hostLabel(f.host));
  const factLines = facts(f).map(([k, v]) => `${k}: ${v}`);
  return [
    headline,
    line,
    "",
    ...factLines,
    "",
    "stderr, last 4 KB:",
    f.stderrTail || f.message,
  ].join("\n");
}

export function AgentFailureCard({
  failure,
  onRetry,
}: {
  failure: AgentFailure;
  /** Resends the chat's last prompt. Omitted when there is none. */
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [relevant, setRelevant] = useState(true);
  const [copied, setCopied] = useState(false);
  const amber = failureTone(failure.cause) === "amber";
  const Icon = amber ? TriangleAlert : OctagonAlert;
  const tone = amber ? "text-amber-600 dark:text-amber-400" : "text-destructive";
  const { headline, line } = describeFailure(failure, hostLabel(failure.host));
  const output = filterOutput(failure.stderrTail || failure.message, relevant);

  const copy = async () => {
    await writeClipboardText(failureReport(failure));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      data-testid="agent-failure"
      data-cause={failure.cause}
      data-tone={amber ? "amber" : "red"}
      className={cn(
        "rounded-lg border p-3 text-sm",
        amber ? "border-amber-500/40 bg-amber-500/5" : "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className={cn("flex items-center gap-2 font-medium", tone)}>
        <Icon className="size-4 shrink-0" aria-hidden />
        <span data-testid="agent-failure__headline">{headline}</span>
      </div>
      <p data-testid="agent-failure__line" className="mt-1 text-foreground">
        {line}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {onRetry && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="agent-failure__retry"
            onClick={onRetry}
          >
            Retry last message
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="agent-failure__copy"
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy details"}
        </Button>
        <button
          type="button"
          data-testid="agent-failure__toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {open ? "Hide details" : "Show details"}
        </button>
      </div>
      {open && (
        <div data-testid="agent-failure__details" className="mt-3 space-y-3">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs">
            {facts(failure).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
          </dl>
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>stderr, last 4 KB</span>
              <div className="ml-auto flex overflow-hidden rounded-md border text-foreground">
                {[true, false].map((r) => (
                  <button
                    key={String(r)}
                    type="button"
                    data-testid={`agent-failure__${r ? "relevant" : "all"}`}
                    aria-pressed={relevant === r}
                    onClick={() => setRelevant(r)}
                    className={cn("px-2 py-0.5", relevant === r && "bg-muted font-medium")}
                  >
                    {r ? "Relevant" : "All output"}
                  </button>
                ))}
              </div>
            </div>
            <pre
              data-testid="agent-failure__output"
              className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs"
            >
              {output.lines.map((l, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines are static text
                  key={i}
                  data-testid={l.error ? "agent-failure__error-line" : undefined}
                  className={cn(
                    "whitespace-pre-wrap break-all",
                    l.error && "bg-destructive/10 font-medium",
                  )}
                >
                  {l.text}
                </div>
              ))}
            </pre>
            {relevant && output.hidden > 0 && (
              <p
                data-testid="agent-failure__hidden"
                data-hidden-count={output.hidden}
                className="mt-1 text-xs text-muted-foreground"
              >
                {output.hidden} lines hidden: {output.hiddenKinds.join(", ")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
