import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { createAuthMiddleware } from "./auth.mjs";

const TEST_SECRET = "test-secret-key-for-auth";
const EXPECTED_TOKEN = createHmac("sha256", TEST_SECRET)
	.update("band-access")
	.digest("hex");

/**
 * Start a test HTTP server with the auth middleware.
 * Returns { url, close } where url is the base URL (http://127.0.0.1:PORT).
 */
function startServer(secret) {
	const { handleAuth } = createAuthMiddleware(secret);

	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (handleAuth(req, res)) return;
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("OK");
		});

		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise((r) => server.close(r)),
			});
		});
	});
}

// -------------------------------------------------------------------------
// Auth enabled (with secret)
// -------------------------------------------------------------------------

describe("auth middleware (with secret)", () => {
	let server;

	beforeEach(async () => {
		server = await startServer(TEST_SECRET);
	});

	afterEach(async () => {
		await server.close();
	});

	it("returns 401 for unauthenticated requests", async () => {
		const res = await fetch(`${server.url}/`);
		assert.equal(res.status, 401);
		const body = await res.text();
		assert.ok(body.includes("Unauthorized"));
	});

	it("returns 401 for requests with invalid token", async () => {
		const res = await fetch(`${server.url}/?token=invalid-token`);
		assert.equal(res.status, 401);
	});

	it("returns 401 for requests with invalid cookie", async () => {
		const res = await fetch(`${server.url}/`, {
			headers: { Cookie: "band_token=wrong-value" },
		});
		assert.equal(res.status, 401);
	});

	it("token endpoint returns token from localhost", async () => {
		const res = await fetch(`${server.url}/api/auth/token`);
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.token, EXPECTED_TOKEN);
	});

	it("valid token query param sets cookie and redirects to clean URL", async () => {
		const res = await fetch(`${server.url}/?token=${EXPECTED_TOKEN}`, {
			redirect: "manual",
		});
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), "/");

		const setCookie = res.headers.get("set-cookie");
		assert.ok(setCookie, "should set a cookie");
		assert.ok(setCookie.includes(`band_token=${EXPECTED_TOKEN}`));
		assert.ok(setCookie.includes("HttpOnly"));
		assert.ok(setCookie.includes("Secure"));
		assert.ok(setCookie.includes("SameSite=Strict"));
		assert.ok(setCookie.includes("Max-Age=86400"));
	});

	it("valid token preserves other query params after redirect", async () => {
		const res = await fetch(
			`${server.url}/chat?project=foo&token=${EXPECTED_TOKEN}&page=1`,
			{ redirect: "manual" },
		);
		assert.equal(res.status, 302);
		const location = res.headers.get("location");
		assert.ok(location.includes("project=foo"), `location=${location}`);
		assert.ok(location.includes("page=1"), `location=${location}`);
		assert.ok(!location.includes("token="), `token should be stripped: ${location}`);
	});

	it("valid cookie allows request through", async () => {
		const res = await fetch(`${server.url}/`, {
			headers: { Cookie: `band_token=${EXPECTED_TOKEN}` },
		});
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.equal(body, "OK");
	});

	it("valid cookie works for any path", async () => {
		const res = await fetch(`${server.url}/some/deep/path`, {
			headers: { Cookie: `band_token=${EXPECTED_TOKEN}` },
		});
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.equal(body, "OK");
	});

	it("token endpoint is only accessible via GET", async () => {
		const res = await fetch(`${server.url}/api/auth/token`, {
			method: "POST",
			headers: { Cookie: `band_token=${EXPECTED_TOKEN}` },
		});
		// POST to token endpoint should pass through to the normal handler
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "OK");
	});
});

// -------------------------------------------------------------------------
// Auth disabled (no secret — dev mode)
// -------------------------------------------------------------------------

describe("auth middleware (without secret — dev mode)", () => {
	let server;

	beforeEach(async () => {
		server = await startServer(undefined);
	});

	afterEach(async () => {
		await server.close();
	});

	it("allows all requests without auth", async () => {
		const res = await fetch(`${server.url}/`);
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "OK");
	});

	it("allows requests to any path without auth", async () => {
		const res = await fetch(`${server.url}/some/path`);
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "OK");
	});

	it("token endpoint does not exist (passes through)", async () => {
		const res = await fetch(`${server.url}/api/auth/token`);
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "OK");
	});
});

// -------------------------------------------------------------------------
// createAuthMiddleware return value
// -------------------------------------------------------------------------

describe("createAuthMiddleware", () => {
	it("returns expected token when secret is provided", () => {
		const { expectedToken } = createAuthMiddleware(TEST_SECRET);
		assert.equal(expectedToken, EXPECTED_TOKEN);
	});

	it("returns null token when no secret is provided", () => {
		const { expectedToken } = createAuthMiddleware(undefined);
		assert.equal(expectedToken, null);
	});

	it("returns null token for empty string secret", () => {
		const { expectedToken } = createAuthMiddleware("");
		assert.equal(expectedToken, null);
	});

	it("different secrets produce different tokens", () => {
		const { expectedToken: t1 } = createAuthMiddleware("secret-a");
		const { expectedToken: t2 } = createAuthMiddleware("secret-b");
		assert.notEqual(t1, t2);
	});
});
