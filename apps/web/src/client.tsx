import { StartClient } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";
import { startPopupWatcher } from "./lib/browser-pane-freeze";

// Install the DOM observer that flips `useBrowserPaneFrozen()` whenever
// any Radix-portalled overlay is on screen — see
// `lib/browser-pane-freeze.ts` for the full rationale. Cheap and
// idempotent; runs once for the life of the page.
startPopupWatcher();

hydrateRoot(document, <StartClient />);
