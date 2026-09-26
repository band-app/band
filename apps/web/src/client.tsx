import { StartClient } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";
import { startBrowserWebviewDomBridge } from "./lib/browser-webview-dom-bridge";

// Repair outside-click dismissal and drag-and-drop across desktop browser
// tabs, which are `<webview>` elements — see
// `lib/browser-webview-dom-bridge.ts`. Cheap and idempotent; a no-op
// without webviews.
startBrowserWebviewDomBridge();

hydrateRoot(document, <StartClient />);
