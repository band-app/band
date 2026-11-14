import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTarGz, type TarEntry } from "./make-tar";

const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/echo-service", import.meta.url));
const SDK = fileURLToPath(
  new URL("../../../../packages/extension-worker-sdk/src", import.meta.url),
);

export interface EchoArchiveOptions {
  version?: string;
  /** `requires` of the service, such as `["os=nonexistent"]`. */
  requires?: string[];
  /** The capability the service reports. */
  capability?: string;
  /** Leave out the panel and the tools (the plain service of PR 2). Defaults to false. */
  plainService?: boolean;
  /**
   * Two services for the capability: `main` needs an os this machine is not running, `alt` needs
   * the current one. The value says which one the manifest lists first.
   */
  osSplit?: "wrong-first" | "wrong-last";
}

export interface EchoArchive {
  bytes: Buffer;
  sha256: string;
  version: string;
}

/** A `.tar.gz` of the echo-service fixture with the SDK copied in, the way an author would ship it. */
export function echoArchive(options: EchoArchiveOptions = {}): EchoArchive {
  const version = options.version ?? "1.0.0";
  const manifest = {
    id: "echo-service",
    name: "Echo service",
    version,
    extensionApi: 1,
    contributes: {
      ...(options.plainService
        ? {}
        : {
            panels: [
              {
                id: "screen",
                label: "Echo screen",
                icon: "monitor",
                entry: "panel.html",
                capability: options.capability ?? "echo",
              },
              {
                id: "auto",
                label: "Echo auto",
                icon: "monitor",
                entry: "panel.html",
                capability: options.capability ?? "echo",
                defaultControl: true,
              },
              {
                id: "bin",
                label: "Echo binary",
                icon: "monitor",
                entry: "panel.html",
                capability: options.capability ?? "echo",
                binaryInput: true,
              },
            ],
            tools: [
              {
                name: "echo",
                description: "Echoes its arguments back from the worker service",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
                service: "main",
                method: "echo",
              },
              ...[
                ["shot", "imageResult"],
                ["badblock", "badBlockResult"],
                ["badmime", "badMimeResult"],
                ["huge", "hugeImageResult"],
                ["plain", "plainResult"],
              ].map(([name, method]) => ({
                name,
                description: `Returns ${method}`,
                service: "main",
                method,
              })),
              {
                name: "hidden",
                description: "Not for agents",
                service: "main",
                method: "echo",
                agent: false,
              },
            ],
          }),
      workerServices: workerServices(options),
    },
  };
  const entries: TarEntry[] = [
    { name: "echo-service/", type: "5" },
    { name: "echo-service/band-extension.json", data: JSON.stringify(manifest) },
    { name: "echo-service/service.mjs", data: readFileSync(join(FIXTURE, "service.mjs")) },
    { name: "echo-service/panel.html", data: readFileSync(join(FIXTURE, "panel.html")) },
    { name: "echo-service/sdk/", type: "5" },
    ...readdirSync(SDK)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => ({ name: `echo-service/sdk/${f}`, data: readFileSync(join(SDK, f)) })),
  ];
  const bytes = makeTarGz(entries);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), version };
}

function workerServices(options: EchoArchiveOptions) {
  const capability = options.capability ?? "echo";
  const base = {
    entry: "service.mjs",
    capability,
    // Only ECHO_DISPLAY is allowed; the fixture also offers names the worker must ignore.
    worktreeEnv: ["ECHO_DISPLAY", "ECHO_UNSET"],
  };
  if (!options.osSplit) return [{ id: "main", requires: options.requires ?? [], ...base }];
  const wrong = { id: "main", requires: ["os=band-test-no-such-os"], ...base };
  const right = { id: "alt", requires: [`os=${process.platform}`], ...base };
  return options.osSplit === "wrong-first" ? [wrong, right] : [right, wrong];
}
