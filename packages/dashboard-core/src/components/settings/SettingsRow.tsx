import { cn, Label } from "@band-app/ui";
import type { ReactNode } from "react";

interface SettingsRowProps {
  /** Bold label rendered on the left side of the row. */
  label?: ReactNode;
  /** Smaller muted description rendered below the label. */
  description?: ReactNode;
  /** Optional leading element (icon or icon-with-badge) rendered to the left of the label block. */
  leadingIcon?: ReactNode;
  /**
   * Forwarded to the rendered <label htmlFor=…>. Set this when the row's
   * control is a single form element so clicking the label focuses it.
   */
  htmlFor?: string;
  /**
   * Layout for the control:
   * - "inline" (default): control is rendered to the right of the label/description.
   *   Best for compact controls (switches, segmented controls, small selects).
   * - "responsive": stacked on mobile (<sm), inline on `sm+`. Use this for text
   *   inputs and select dropdowns that get cramped next to a long label on
   *   narrow screens but read fine on the right at desktop widths.
   * - "stacked": always stacked (label/description on top, control below).
   *   Use for controls that always need full width.
   */
  variant?: "inline" | "responsive" | "stacked";
  /** The control. Rendered on the right (inline) or below (stacked). */
  children?: ReactNode;
  className?: string;
}

/**
 * Row primitive used inside a SettingsSection. Renders a left-side label
 * (with optional description and leading icon) and a right-side control,
 * mirroring the Codex settings reference. For controls that need full
 * width on mobile but read fine inline on desktop, pass `variant="responsive"`.
 */
export function SettingsRow({
  label,
  description,
  leadingIcon,
  htmlFor,
  variant = "inline",
  children,
  className,
}: SettingsRowProps) {
  const labelBlock = (label || description) && (
    <div className="min-w-0 flex-1 space-y-1">
      {label ? (
        <Label htmlFor={htmlFor} className="text-sm font-medium leading-tight text-foreground">
          {label}
        </Label>
      ) : null}
      {description ? (
        <p className="text-xs leading-snug text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );

  if (variant === "stacked") {
    return (
      <div data-slot="settings-row" className={cn("space-y-2.5 px-4 py-3.5", className)}>
        <div className="flex items-start gap-3">
          {leadingIcon ? <div className="mt-0.5 shrink-0">{leadingIcon}</div> : null}
          {labelBlock}
        </div>
        {children ? <div>{children}</div> : null}
      </div>
    );
  }

  if (variant === "responsive") {
    return (
      <div
        data-slot="settings-row"
        className={cn(
          "flex flex-col gap-2.5 px-4 py-3.5",
          "sm:flex-row sm:items-center sm:gap-4 sm:py-3",
          className,
        )}
      >
        {leadingIcon ? <div className="shrink-0 sm:mt-0">{leadingIcon}</div> : null}
        {labelBlock}
        {children ? <div className="sm:shrink-0">{children}</div> : null}
      </div>
    );
  }

  return (
    <div data-slot="settings-row" className={cn("flex items-center gap-4 px-4 py-3", className)}>
      {leadingIcon ? <div className="shrink-0">{leadingIcon}</div> : null}
      {labelBlock}
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}
