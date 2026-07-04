import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useEffect } from "react";

import { cn } from "../utils";
import { Button } from "./button";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

// Base positioning + entry/exit animation per DialogContent variant. The
// `default` variant is the classic centred modal. `bottom-sheet` anchors to
// the bottom edge as a drawer on mobile (slide up, rounded top, capped
// height with a safe-area gap so the header clears the iOS notch), then
// reverts to the centred modal at the `lg` breakpoint — desktop is left
// exactly as the default variant.
//
// `command-palette` is the layout for the searchable command dialogs (quick
// open, find in files, switch workspace, command palette, language picker).
// Unlike the other variants it deliberately does NOT centre vertically:
//   - Desktop (lg+): the card is anchored in the upper third by its TOP edge
//     with no `translate-y`, so the search input (the first child) stays at a
//     fixed Y while the results list grows/shrinks downward beneath it. A
//     centred modal would bob the input up and down as results change.
//   - Mobile (< lg): a bottom drawer whose input is pinned to the BOTTOM,
//     just above the on-screen keyboard (easy thumb reach), with the results
//     list above it. The input/list order is flipped visually only, by
//     reversing the `<Command>` flex direction (DOM order + cmdk keyboard nav
//     are untouched). The sheet sits at `bottom: var(--kb-inset)` (see
//     `useKeyboardInset`), a JS-maintained variable equal to the keyboard's
//     occluded height, so the input rides *above* the keyboard on iOS Safari
//     too — where the layout viewport is never resized and a `bottom: 0` sheet
//     would otherwise be drawn under the keyboard. The `max-h` subtracts the
//     same inset so the sheet's top can't run past the safe-area gap.
//
// The breakpoint is `lg` (1024px), NOT `sm`, so it matches the app's own
// mobile/desktop switch (`useIsDesktop` = `min-width: 1024px`): below 1024px
// the app renders its mobile layout, so the dialogs must be bottom drawers
// across that whole range. The `max-lg:`/`lg:` split keeps the slide
// animation mobile-only and the zoom animation desktop-only.
const DIALOG_CONTENT_VARIANTS = {
  default:
    "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
  "bottom-sheet": [
    // Shared
    "fixed z-50 flex flex-col bg-background shadow-lg duration-200 outline-none",
    "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
    // Mobile (< lg): bottom drawer
    "inset-x-0 bottom-0 w-full max-w-none rounded-t-2xl border border-b-0 p-6",
    "max-h-[calc(100dvh-env(safe-area-inset-top)-1.5rem)]",
    "max-lg:data-[state=open]:slide-in-from-bottom max-lg:data-[state=closed]:slide-out-to-bottom",
    // Desktop (lg+): revert to the centred modal
    "lg:inset-auto lg:top-[50%] lg:left-[50%] lg:bottom-auto lg:w-full lg:max-w-lg lg:max-h-[85vh] lg:translate-x-[-50%] lg:translate-y-[-50%] lg:rounded-lg lg:border-b",
    "lg:data-[state=open]:zoom-in-95 lg:data-[state=closed]:zoom-out-95",
  ].join(" "),
  "command-palette": [
    // Shared
    "fixed z-50 flex flex-col bg-background shadow-lg duration-200 outline-none",
    "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
    // Mobile (< lg): bottom drawer with the input pinned to the bottom. Flip
    // the command's flex direction so the input sits below the results list,
    // and flip the input wrapper's divider to a top border to match. The sheet
    // floats at `bottom: var(--kb-inset)` (keyboard height; 0 when closed) so
    // the input clears the on-screen keyboard — see `useKeyboardInset`.
    "inset-x-0 bottom-[var(--kb-inset,0px)] w-full max-w-none rounded-t-2xl border border-b-0",
    "max-h-[calc(100dvh-var(--kb-inset,0px)-env(safe-area-inset-top)-1.5rem)]",
    "max-lg:[&_[data-slot=command]]:flex-col-reverse",
    "max-lg:[&_[cmdk-input-wrapper]]:border-t max-lg:[&_[cmdk-input-wrapper]]:border-b-0",
    "max-lg:data-[state=open]:slide-in-from-bottom max-lg:data-[state=closed]:slide-out-to-bottom",
    // Desktop (lg+): anchored in the upper third by its TOP edge — no
    // `translate-y`, so the input never moves as the list grows downward.
    "lg:inset-x-auto lg:bottom-auto lg:top-[12vh] lg:left-1/2 lg:w-full lg:max-w-lg lg:max-h-[70vh] lg:-translate-x-1/2 lg:rounded-lg lg:border",
    "lg:data-[state=open]:zoom-in-95 lg:data-[state=closed]:zoom-out-95",
  ].join(" "),
} as const;

/**
 * Keep a `--kb-inset` CSS variable on the document root in sync with the
 * on-screen keyboard's occluded height, so the mobile `command-palette` bottom
 * sheet can float above the keyboard rather than be drawn under it.
 *
 * Only Chrome Android honours the `interactive-widget=resizes-content` viewport
 * hint (which shrinks the layout viewport so a `bottom: 0` sheet already clears
 * the keyboard). iOS Safari never resizes the layout viewport for the keyboard,
 * so a `position: fixed; bottom: 0` element stays put and the keyboard overlays
 * it. `visualViewport` reports the occluded height on both platforms, so we
 * drive the sheet's `bottom` (and `max-height`) off it. On
 * Android-with-resizes-content the computed inset is ~0 (the layout viewport
 * already shrank), making this a no-op there — no double offset.
 *
 * Runs only while a `command-palette` dialog is mounted (Radix mounts content
 * on open, unmounts after the close animation), so the listeners are scoped to
 * the dialog's lifetime.
 */
function useKeyboardInset(active: boolean) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const root = document.documentElement;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--kb-inset", `${inset}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--kb-inset");
    };
  }, [active]);
}

function DialogContent({
  className,
  overlayClassName,
  children,
  showCloseButton = true,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  /** Extra classes for the backdrop overlay (e.g. `backdrop-blur-sm`). */
  overlayClassName?: string;
  /**
   * Layout variant. `default` is the centred modal; `bottom-sheet` renders a
   * bottom drawer on mobile (with a top safe-area gap) that reverts to the
   * centred modal on desktop (`lg`+, 1024px — matching `useIsDesktop`).
   * `command-palette` is for searchable command dialogs: upper-third
   * top-anchored on desktop (fixed input, list grows downward) and a
   * bottom drawer with the input pinned below the list on mobile.
   */
  variant?: keyof typeof DIALOG_CONTENT_VARIANTS;
}) {
  // Track the keyboard height for the mobile command-palette bottom sheet so
  // its input clears the on-screen keyboard. No-op for the other variants.
  useKeyboardInset(variant === "command-palette");
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-variant={variant}
        className={cn(DIALOG_CONTENT_VARIANTS[variant], className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
