import { createHmac, timingSafeEqual } from "node:crypto";

function isLocalhost(req) {
	const addr = req.socket.remoteAddress;
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function parseCookies(req) {
	const header = req.headers.cookie || "";
	const cookies = {};
	for (const pair of header.split(";")) {
		const [name, ...rest] = pair.trim().split("=");
		if (name) cookies[name] = rest.join("=");
	}
	return cookies;
}

function tokensEqual(a, b) {
	if (!a || !b) return false;
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/**
 * Create an auth middleware function.
 * @param {string | undefined} secret - The BAND_TOKEN_SECRET. If falsy, auth is disabled.
 * @returns {{ handleAuth: (req, res) => boolean, expectedToken: string | null }}
 */
export function createAuthMiddleware(secret) {
	const expectedToken = secret
		? createHmac("sha256", secret).update("band-access").digest("hex")
		: null;

	/**
	 * Returns true if the request was handled (auth endpoint or rejection).
	 * Returns false if the request should continue to the normal handler.
	 */
	function handleAuth(req, res) {
		// No secret configured — skip auth entirely (dev mode)
		if (!expectedToken) return false;

		const url = new URL(req.url, `http://${req.headers.host}`);

		// Localhost-only token endpoint
		if (url.pathname === "/api/auth/token" && req.method === "GET") {
			if (isLocalhost(req)) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ token: expectedToken }));
			} else {
				res.writeHead(403);
				res.end("Forbidden");
			}
			return true;
		}

		// Check token in query param
		const queryToken = url.searchParams.get("token");
		if (queryToken && tokensEqual(queryToken, expectedToken)) {
			// Set cookie and continue to normal handler (no redirect — tunnel
			// proxies follow redirects internally and lose the Set-Cookie).
			res.setHeader(
				"Set-Cookie",
				`band_token=${expectedToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
			);
			return false;
		}

		// Check cookie
		const cookies = parseCookies(req);
		if (tokensEqual(cookies.band_token, expectedToken)) {
			return false; // Authenticated — continue to normal handler
		}

		// Unauthorized
		res.writeHead(401, { "Content-Type": "text/html" });
		res.end(`<!DOCTYPE html>
<html><head><title>Unauthorized</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff}
.c{text-align:center}h1{font-size:4rem;margin:0}p{color:#888}</style></head>
<body><div class="c"><h1>401</h1><p>Scan the QR code from the Band dashboard to access this page.</p></div></body></html>`);
		return true;
	}

	return { handleAuth, expectedToken };
}
