import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sirv from "sirv";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const clientDir = join(__dirname, "dist", "client");
const port = parseInt(process.env.PORT || "3456", 10);

const assets = sirv(clientDir, {
	maxAge: 31536000,
	immutable: true,
	gzip: true,
	etag: true,
});

async function main() {
	const mod = await import("./dist/server/server.js");
	const server = mod.default;

	const httpServer = createServer(async (req, res) => {
		// Try serving static assets first (sirv calls next() if no match)
		assets(req, res, async () => {
			const protocol = "http";
			const url = new URL(req.url, `${protocol}://${req.headers.host}`);

			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (value) {
					if (Array.isArray(value)) {
						for (const v of value) headers.append(key, v);
					} else {
						headers.set(key, value);
					}
				}
			}

			let body = undefined;
			if (req.method !== "GET" && req.method !== "HEAD") {
				body = await new Promise((resolve, reject) => {
					const chunks = [];
					req.on("data", (chunk) => chunks.push(chunk));
					req.on("end", () => resolve(Buffer.concat(chunks)));
					req.on("error", reject);
				});
			}

			const request = new Request(url.toString(), {
				method: req.method,
				headers,
				body,
				duplex: "half",
			});

			const response = await server.fetch(request);

			res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

			if (response.body) {
				const reader = response.body.getReader();
				const pump = async () => {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							res.end();
							break;
						}
						res.write(value);
					}
				};
				pump().catch(() => res.end());
			} else {
				const text = await response.text();
				res.end(text);
			}
		});
	});

	httpServer.listen(port, "0.0.0.0", () => {
		console.log(`Web server listening on http://0.0.0.0:${port}`);
	});
}

main().catch((err) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
