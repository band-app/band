import { type Href, router } from "expo-router";

/** Shows `href` as the only screen, so Back can't return to pairing or the unreachable screen. */
export function resetTo(href: Href): void {
  if (router.canDismiss()) router.dismissAll();
  router.replace(href);
}
