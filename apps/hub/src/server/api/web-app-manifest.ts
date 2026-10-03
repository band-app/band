import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The web app manifest and its icons. Without a manifest, iOS derives a
// home-screen app's scope from the URL it was added from (often
// `/workspace/<id>`), and a client-side switch to another project's workspace
// leaves that scope and brings up Safari's browser bars. `scope: "/"` keeps
// every Band URL in the app.
//
// iOS fetches the manifest and icons without the session cookie, so these
// routes are answered before auth. They carry no token and no workspace data.
// ---------------------------------------------------------------------------

/** Linked from the page head in `routes/__root.tsx`. */
const WEB_APP_MANIFEST_PATH = "/manifest.webmanifest";

/** Icons under `public/icons/` (copied to `dist/client/icons/` by the build). */
const ICON_FILES = ["band-192.png", "band-512.png", "apple-touch-icon.png"] as const;

const WEB_APP_MANIFEST = {
  name: "Band",
  short_name: "Band",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  theme_color: "#1e1e1e",
  background_color: "#1e1e1e",
  icons: [
    { src: "/icons/band-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/band-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
};

/** Answers the manifest and its icons. Returns false for any other request.
 *  `publicDir` is the directory holding `icons/`: `public/` in dev,
 *  `dist/client/` in production. */
export function handleWebAppManifest(
  req: IncomingMessage,
  res: ServerResponse,
  publicDir: string,
): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const pathname = req.url?.split("?")[0];

  if (pathname === WEB_APP_MANIFEST_PATH) {
    res.writeHead(200, {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(WEB_APP_MANIFEST));
    return true;
  }

  const icon = ICON_FILES.find((name) => pathname === `/icons/${name}`);
  if (!icon) return false;
  const filePath = join(publicDir, "icons", icon);
  try {
    const { size } = statSync(filePath);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": size.toString(),
      "Cache-Control": "public, max-age=86400",
    });
    if (req.method === "HEAD") res.end();
    // A read that fails after the 200 ends the response instead of
    // crashing the server with an unhandled stream error.
    else
      createReadStream(filePath)
        .on("error", () => res.destroy())
        .pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
  return true;
}
