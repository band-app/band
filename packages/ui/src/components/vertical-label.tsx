import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../utils";

interface VerticalLabelProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Optional icon shown above the rotated label. */
  icon?: ReactNode;
  /** Optional dot indicator color (hex/rgb). Rendered between the icon and the
   *  label — typically used to surface an active filter or selection. */
  indicatorColor?: string;
  /** aria-label applied to the indicator dot when present. */
  indicatorAriaLabel?: string;
  /** Rotated label text. */
  children: ReactNode;
}

/**
 * Vertical label rail used in collapsed sidebars / panel strips. Renders an
 * optional icon, an optional colored indicator dot, and the label text rotated
 * with `writing-mode: vertical-rl` + 180° so glyphs read top-to-bottom.
 */
export function VerticalLabel({
  icon,
  indicatorColor,
  indicatorAriaLabel,
  children,
  className,
  ...rest
}: VerticalLabelProps) {
  return (
    <div {...rest} className={cn("flex flex-col items-center gap-2 select-none", className)}>
      {icon}
      {indicatorColor && (
        <span
          role="img"
          aria-label={indicatorAriaLabel}
          className="size-2.5 rounded-full shrink-0"
          style={{ backgroundColor: indicatorColor }}
        />
      )}
      <span
        className="text-xs font-medium tracking-wide text-muted-foreground"
        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
      >
        {children}
      </span>
    </div>
  );
}
