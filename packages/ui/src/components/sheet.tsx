import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "../utils";

/**
 * Sheet — a Radix Dialog styled as an edge-anchored drawer.
 *
 * Shares Radix Dialog's semantics with the `Dialog` primitive (focus trap,
 * Escape to close, click-outside to close, portal + backdrop overlay) but
 * slides in from a screen edge rather than fading into the centre. Used for
 * the mobile project-list fly-out (`side="left"`). The `side="bottom"` variant
 * is provided for parity; the app's modal dialogs that morph into bottom
 * drawers on mobile use `DialogContent variant="bottom-sheet"` instead so the
 * desktop centred layout is preserved.
 */

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "left",
  showCloseButton = true,
  overlayClassName,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  /** Which edge the sheet slides in from. Defaults to "left". */
  side?: "left" | "right" | "bottom" | "top";
  showCloseButton?: boolean;
  /** Extra classes for the backdrop overlay (e.g. `backdrop-blur-sm`). */
  overlayClassName?: string;
}) {
  return (
    <SheetPortal data-slot="sheet-portal">
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed z-50 flex flex-col bg-background shadow-lg outline-none transition ease-in-out data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:animate-in data-[state=open]:duration-500",
          side === "left" &&
            "inset-y-0 left-0 h-full w-[85%] max-w-sm border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
          side === "right" &&
            "inset-y-0 right-0 h-full w-[85%] max-w-sm border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
          // Bottom sheet: leave a safe-area gap at the top so the header/close
          // button stay clear of the iOS notch / status bar. env() insets are
          // additive to the fixed 1.5rem so the gap is never smaller than the
          // physical safe area.
          side === "bottom" &&
            "inset-x-0 bottom-0 max-h-[calc(100dvh-env(safe-area-inset-top)-1.5rem)] w-full rounded-t-2xl border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
          side === "top" &&
            "inset-x-0 top-0 w-full rounded-b-2xl border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-foreground font-semibold", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
