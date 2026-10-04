/**
 * Serves the `band` CLI to workers (plan step 2.8).
 *
 * A worker asks for the binary built for its own platform with `cli.fetch`
 * and keeps it in its state dir, so the agents and terminals it starts have
 * `band` on their PATH. The hub looks for a binary in this order:
 *
 *   1. `$BAND_CLI_BINARIES_DIR/band-<platform>-<arch>`, for a hub that serves
 *      workers of other platforms (`band-linux-x64`, `band-linux-arm64`,
 *      `band-darwin-arm64`, ...).
 *   2. The hub's own CLI (`findCliBinary`), when the worker has the hub's
 *      platform and architecture.
 *
 * With neither, the answer is `available: false` and the worker runs without
 * `band`.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findCliBinary } from "@band-app/host-local/process/cli-binary";
import {
  type CliFetchParams,
  type CliFetchReply,
  METHOD_CLI_FETCH,
  RpcError,
  type ServerSession,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";

const log = createLogger("worker-cli");

const RPC_INVALID_PARAMS = -32602;
const PLATFORM_NAME = /^[a-z0-9_]{1,16}$/;

/** The files that may hold the CLI for a worker of this platform, best first. */
function candidatesFor(platform: string, arch: string): string[] {
  const out: string[] = [];
  const dir = process.env.BAND_CLI_BINARIES_DIR;
  if (dir) out.push(join(dir, `band-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`));
  if (platform === process.platform && arch === process.arch) {
    const own = findCliBinary();
    if (own) out.push(own);
  }
  return out;
}

async function readFirst(paths: string[]): Promise<Buffer | null> {
  for (const path of paths) {
    const data = await readFile(path).catch(() => null);
    if (data) return data;
  }
  return null;
}

export class WorkerCliService {
  /** Answers `cli.fetch` on a worker's session. */
  attach(session: ServerSession): void {
    session.handle(METHOD_CLI_FETCH, (params) => this.handle(session, params));
  }

  private async handle(session: ServerSession, params: unknown): Promise<CliFetchReply> {
    const { platform, arch, have } = parseParams(params);
    const data = await readFirst(candidatesFor(platform, arch));
    if (!data) {
      return {
        available: false,
        reason: `the hub has no band CLI for ${platform}-${arch}`,
      };
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (have === sha256) return { available: true, sha256, size: data.length };

    log.info(
      `sending the band CLI (${platform}-${arch}, ${data.length} bytes) to ${session.workerId}`,
    );
    const ch = session.openChannel("cli.body", { platform, arch });
    void (async () => {
      try {
        await ch.send(data);
        ch.end();
        // The worker ends its side once it has the body. Reading that end marker is what
        // lets the channel close, and an open channel keeps an ephemeral worker from going idle.
        const drained = setTimeout(() => ch.reset("the worker did not close the channel"), 30_000);
        drained.unref?.();
        await ch.readAll().finally(() => clearTimeout(drained));
      } catch (err) {
        ch.reset(err instanceof Error ? err.message : "cli transfer failed");
      }
    })();
    return { available: true, sha256, size: data.length, chan: ch.id };
  }
}

function parseParams(params: unknown): CliFetchParams {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.platform !== "string" || !PLATFORM_NAME.test(p.platform)) {
    throw new RpcError(RPC_INVALID_PARAMS, "platform must be a short lowercase name");
  }
  if (typeof p.arch !== "string" || !PLATFORM_NAME.test(p.arch)) {
    throw new RpcError(RPC_INVALID_PARAMS, "arch must be a short lowercase name");
  }
  if (p.have !== undefined && typeof p.have !== "string") {
    throw new RpcError(RPC_INVALID_PARAMS, "have must be a string");
  }
  return { platform: p.platform, arch: p.arch, have: p.have };
}

export const workerCliService = new WorkerCliService();
