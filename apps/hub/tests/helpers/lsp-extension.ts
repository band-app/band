// A stand-in for the official `typescript-lsp` extension. The archive holds a manifest and a
// launcher that runs the `typescript-language-server` this app installs as a dev dependency, so
// a test gets the real language server with no network. The extension is installed on the hub
// the way a person installs one, and a worker downloads it.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTarGz } from "./make-tar";
import { waitFor } from "./wait-for";

/** The `lang` of the TypeScript server's `/lsp` socket: `<extension id>/<server id>`. */
export const TS_LSP_KEY = "typescript-lsp/typescript";

const CLI = realpathSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "node_modules",
    "typescript-language-server",
    "lib",
    "cli.mjs",
  ),
);

export interface LspArchiveOptions {
  version?: string;
  /** `requires` of the server, such as `["definitely-not-a-binary"]`. */
  requires?: string[];
  /** Files at the worktree root that mark a project. */
  rootMarkers?: string[];
}

export function tsLspArchive(options: LspArchiveOptions = {}): {
  bytes: Buffer;
  sha256: string;
  version: string;
} {
  const version = options.version ?? "1.0.0";
  const manifest = {
    id: "typescript-lsp",
    name: "TypeScript language server",
    version,
    extensionApi: 1,
    contributes: {
      languageServers: [
        {
          id: "typescript",
          languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
          files: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.cts", "*.mjs", "*.cjs"],
          command: "server.mjs",
          args: ["--stdio"],
          rootMarkers: options.rootMarkers ?? ["package.json", "tsconfig.json", "jsconfig.json"],
          requires: options.requires ?? [],
        },
      ],
    },
  };
  const bytes = makeTarGz([
    { name: "typescript-lsp/", type: "5" },
    { name: "typescript-lsp/band-extension.json", data: JSON.stringify(manifest) },
    {
      name: "typescript-lsp/server.mjs",
      data: `import ${JSON.stringify(pathToFileURL(CLI).href)};\n`,
    },
  ]);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), version };
}

interface HostsReply {
  result: {
    data: {
      hosts: Array<{
        id: string;
        languageServers: Array<{ key: string; state: string; reason?: string }>;
      }>;
    };
  };
}

async function languageServers(url: string, token: string, hostId: string) {
  const res = await fetch(`${url}/trpc/workers.list`, {
    headers: { Cookie: `band_token=${token}` },
  });
  const body = (await res.json()) as HostsReply;
  return body.result.data.hosts.find((h) => h.id === hostId)?.languageServers ?? [];
}

/** Installs the TypeScript server extension on the hub at `url`. */
export async function installTsLsp(
  url: string,
  token: string,
  options: LspArchiveOptions = {},
): Promise<void> {
  // BAND_TS_LSP_ARCHIVE=<path> installs the packed release of band-extensions' typescript-lsp
  // instead of the stand-in, to check the two agree.
  const real = process.env.BAND_TS_LSP_ARCHIVE;
  const res = await fetch(`${url}/api/extensions/install`, {
    method: "POST",
    headers: { Cookie: `band_token=${token}` },
    body: real ? readFileSync(real) : tsLspArchive(options).bytes,
  });
  if (res.status !== 200) throw new Error(`install failed: HTTP ${res.status} ${await res.text()}`);
}

/** Waits until the worker reports the server in `state`, and returns what it reported. */
export async function waitForLanguageServer(
  url: string,
  token: string,
  hostId: string,
  state: "ready" | "unavailable" = "ready",
) {
  return waitFor(
    async () =>
      (await languageServers(url, token, hostId)).find(
        (s) => s.key === TS_LSP_KEY && s.state === state,
      ),
    { label: `the ${state} language server on ${hostId}`, timeoutMs: 30_000, intervalMs: 200 },
  );
}

export { languageServers };
