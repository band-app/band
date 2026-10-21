import { cn } from "@band-app/ui";
import type { ReactNode } from "react";

/** The message of a failed call, for the error line under a control. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A section of a repo's settings page: one card whose header holds the title, a one-line
 * description and, on the right, where the setting used to live ("from Repos"). Rows and lists
 * go below the header, separated by 1px dividers.
 */
export function RepoSection({
  title,
  description,
  from,
  testId,
  children,
}: {
  title: string;
  description?: ReactNode;
  from?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="overflow-hidden rounded-xl border border-border"
      data-testid={testId}
      aria-label={title}
    >
      <header className="flex items-baseline justify-between gap-3 border-border border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {from ? (
          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
            {from}
          </span>
        ) : null}
      </header>
      <div className="[&>*+*]:border-border [&>*+*]:border-t">{children}</div>
    </section>
  );
}

/**
 * One row of a repo section: a 220px label column (bold label and a muted description) and the
 * control right after it. `readOnly` gives the row the page background, for values that cannot
 * be changed here.
 */
export function RepoRow({
  label,
  description,
  htmlFor,
  readOnly,
  testId,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  readOnly?: boolean;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 items-center gap-2 px-4 py-3 sm:grid-cols-[220px_1fr] sm:gap-4",
        readOnly && "bg-muted/40",
      )}
      data-testid={testId}
    >
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-[13px] font-semibold">
            {label}
          </label>
        ) : (
          <div className="text-[13px] font-semibold">{label}</div>
        )}
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

const CHIP_TONES = {
  neutral: "bg-muted text-foreground",
  ok: "bg-success-bg text-success",
  warn: "bg-warning-bg text-warning",
  scoped: "bg-info-bg text-info",
} as const;

/** A small rounded status label: `ok` green, `warn` amber, `scoped` for a limit or an override. */
export function Chip({
  tone = "neutral",
  testId,
  children,
}: {
  tone?: keyof typeof CHIP_TONES;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-px text-xs",
        CHIP_TONES[tone],
      )}
      data-testid={testId}
      data-tone={tone}
    >
      {children}
    </span>
  );
}

/** The muted text beside a control. */
export function Hint({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span className="text-xs text-muted-foreground" data-testid={testId}>
      {children}
    </span>
  );
}

/** The native select the repo page uses, styled to match the design. */
export const SELECT_CLASS =
  "h-8 min-w-48 rounded-md border border-border bg-background px-2 text-sm disabled:opacity-60";
