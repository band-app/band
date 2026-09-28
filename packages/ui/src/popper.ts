/**
 * Size limits for Radix popper content (menus, submenus, selects, popovers).
 *
 * Radix reports the room left between the trigger and the window edge as
 * `--radix-popper-available-height` / `-width` on the popper wrapper, in
 * viewport pixels. The web app zooms its whole UI with CSS `zoom` on `<html>`
 * and publishes the factor as `--app-zoom`. Inside zoomed content one CSS
 * pixel is `--app-zoom` viewport pixels, so the reported room is divided by
 * the factor; without that a menu at 110% comes out 10% taller than the space
 * it was given and its last rows fall off the window.
 *
 * A caller that wants a smaller upper bound sets `--popper-max-height` on the
 * content (`className="[--popper-max-height:400px]"`); the window still caps
 * it. The variable doesn't leak into submenus, which render in their own
 * portal.
 */
export const POPPER_MAX_HEIGHT =
  "max-h-[min(var(--popper-max-height,100dvh),calc(var(--radix-popper-available-height)/var(--app-zoom,1)))]";

export const POPPER_MAX_WIDTH =
  "max-w-[calc(var(--radix-popper-available-width)/var(--app-zoom,1))]";

/** The trigger's width, so a select list is at least as wide as its trigger. */
export const POPPER_TRIGGER_WIDTH =
  "min-w-[calc(var(--radix-popper-anchor-width)/var(--app-zoom,1))]";
