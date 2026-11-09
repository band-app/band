import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useState } from "react";

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export interface NotificationAction {
  label: string;
  onClick: () => void;
  /** The filled button; the others are outlined or ghost. */
  primary?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  testId?: string;
}

export interface NotificationProps {
  severity: NotificationSeverity;
  title: string;
  /** Text under the title. Long text is clamped, with a "More" button that opens it in a dialog. */
  details?: string;
  /** Extra content under the details (release notes, a link). */
  children?: ReactNode;
  actions?: NotificationAction[];
  /** 0 to 1 draws a bar at that fraction; `"indeterminate"` draws a moving bar. */
  progress?: number | "indeterminate";
  progressLabel?: string;
  /** Replaces the severity icon (a spinner while checking). */
  icon?: ReactNode;
  onClose?: () => void;
  testId: string;
}

const SEVERITY = {
  info: { Icon: Info, text: "text-info" },
  success: { Icon: CircleCheck, text: "text-success" },
  warning: { Icon: TriangleAlert, text: "text-warning" },
  error: { Icon: CircleAlert, text: "text-destructive" },
} as const;

/**
 * The one notification card every toast in the bottom-right stack (`ToastHost`) uses: a severity
 * icon, a title, optional details, an optional progress bar, actions and a close button.
 */
export function Notification({
  severity,
  title,
  details,
  children,
  actions,
  progress,
  progressLabel,
  icon,
  onClose,
  testId,
}: NotificationProps) {
  const [showMore, setShowMore] = useState(false);
  const { Icon, text } = SEVERITY[severity];
  const long = details !== undefined && (details.length > 140 || details.includes("\n"));

  return (
    <output
      aria-live="polite"
      data-testid={testId}
      data-severity={severity}
      className="pointer-events-auto relative block rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2 duration-200"
    >
      {onClose && (
        <button
          type="button"
          aria-label="Close"
          data-testid={`${testId}__close`}
          onClick={onClose}
          className="absolute top-2 right-2 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
      <div className="flex gap-2.5 pr-6">
        <span className={`mt-0.5 shrink-0 ${text}`} data-testid={`${testId}__icon`}>
          {icon ?? <Icon className="size-4" />}
        </span>
        <div className="min-w-0">
          <p className="break-words font-medium" data-testid={`${testId}__title`}>
            {title}
          </p>
          {details && (
            <p
              className="mt-0.5 line-clamp-3 break-words text-xs text-muted-foreground"
              data-testid={`${testId}__details`}
            >
              {details}
            </p>
          )}
          {long && (
            <button
              type="button"
              onClick={() => setShowMore(true)}
              className="mt-0.5 text-xs text-primary underline-offset-4 hover:underline"
            >
              More
            </button>
          )}
        </div>
      </div>
      {children && <div className="mt-2 pl-6.5">{children}</div>}
      {progress !== undefined && (
        <div
          role="progressbar"
          aria-label={progressLabel ?? title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress === "indeterminate" ? undefined : Math.round(progress * 100)}
          className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={`h-full rounded-full bg-primary transition-[width] duration-300 ease-out ${
              progress === "indeterminate" ? "w-1/3 animate-pulse" : ""
            }`}
            style={progress === "indeterminate" ? undefined : { width: `${progress * 100}%` }}
          />
        </div>
      )}
      {actions && actions.length > 0 && (
        <div className="mt-3 flex justify-end gap-2">
          {actions.map((action, i) => (
            <Button
              key={action.label}
              variant={
                action.primary ? "default" : i === 0 && actions.length > 1 ? "ghost" : "outline"
              }
              size="xs"
              disabled={action.busy}
              data-testid={action.testId}
              onClick={action.onClick}
            >
              {action.icon}
              {action.label}
            </Button>
          ))}
        </div>
      )}
      {long && (
        <Dialog open={showMore} onOpenChange={setShowMore}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className={text}>{title}</DialogTitle>
            </DialogHeader>
            <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-sm select-all">
              {details}
            </pre>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard.writeText(details ?? "")}
              >
                Copy
              </Button>
              <Button size="sm" onClick={() => setShowMore(false)}>
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </output>
  );
}
