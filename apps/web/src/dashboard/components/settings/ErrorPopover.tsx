import { Button, Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * An error as a destructive icon. The message, an optional Dismiss action and any extra
 * actions live in its popover. `testId` names the message; the icon is `<testId>-icon`.
 */
export function ErrorPopover({
  label,
  testId,
  message,
  onDismiss,
  dismissTestId = "settings__host-update-dismiss",
  children,
}: {
  label: string;
  testId: string;
  message: string | null | undefined;
  onDismiss?: () => void;
  dismissTestId?: string;
  children?: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={`${testId}-icon`}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 rounded-sm text-destructive"
        >
          <CircleAlert className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 text-xs">
        <p role="alert" data-testid={testId} className="break-words text-destructive">
          {message}
        </p>
        {children}
        {onDismiss ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={dismissTestId}
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
