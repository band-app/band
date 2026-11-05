import { StartClient } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";
import { startBrowserWebviewDomBridge } from "./lib/browser-webview-dom-bridge";

// Repair outside-click dismissal and drag-and-drop across desktop browser
// tabs, which are `<webview>` elements — see
// `lib/browser-webview-dom-bridge.ts`. Cheap and idempotent; a no-op
// without webviews.
startBrowserWebviewDomBridge();

// A file dropped outside a drop target would make the browser (or Electron)
// open it and navigate away from the app. Cancel the default for file drags.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  });
}

hydrateRoot(document, <StartClient />);
