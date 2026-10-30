import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { findBinary, run } from "./tools.ts";

const INSTALL_HINT =
  "Input needs idb. Install it with `brew install facebook/fb/idb-companion` and `pipx install fb-idb`, or set BAND_IDB_BIN and BAND_IDB_COMPANION_BIN.";

interface Companion {
  child: ChildProcess;
  port: number;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Touch, text and hardware buttons for a booted simulator, through idb. `simctl` has no tap, and
 * idb is the maintained route to the simulator's HID layer. One `idb_companion` runs per booted
 * device, started on first input and stopped with the device.
 */
export class Input {
  private readonly companions = new Map<string, Promise<Companion>>();

  constructor(private readonly deviceSetDir: string) {}

  available(): boolean {
    return (
      findBinary("idb", "BAND_IDB_BIN") !== null &&
      findBinary("idb_companion", "BAND_IDB_COMPANION_BIN") !== null
    );
  }

  private companion(udid: string): Promise<Companion> {
    let existing = this.companions.get(udid);
    if (!existing) {
      existing = this.startCompanion(udid);
      this.companions.set(udid, existing);
      existing.catch(() => this.companions.delete(udid));
    }
    return existing;
  }

  private async startCompanion(udid: string): Promise<Companion> {
    const bin = findBinary("idb_companion", "BAND_IDB_COMPANION_BIN");
    if (!bin) throw new Error(INSTALL_HINT);
    const port = await freePort();
    const child = spawn(
      bin,
      [
        "--udid",
        udid,
        "--device-set-path",
        this.deviceSetDir,
        "--grpc-port",
        String(port),
        "--idle-shutdown-time",
        "900",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    child.once("exit", () => this.companions.delete(udid));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("idb_companion did not start")), 30_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("grpc_port")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`idb_companion exited with code ${code}`));
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return { child, port };
  }

  private async idb(udid: string, args: string[]): Promise<string> {
    const bin = findBinary("idb", "BAND_IDB_BIN");
    if (!bin) throw new Error(INSTALL_HINT);
    const { port } = await this.companion(udid);
    const { stdout } = await run(
      bin,
      ["--companion", `localhost:${port}`, ...args, "--udid", udid],
      {
        timeoutMs: 60_000,
      },
    );
    return stdout;
  }

  tap(udid: string, x: number, y: number): Promise<string> {
    return this.idb(udid, ["ui", "tap", String(x), String(y)]);
  }

  type(udid: string, text: string): Promise<string> {
    return this.idb(udid, ["ui", "text", text]);
  }

  button(udid: string, name: string): Promise<string> {
    return this.idb(udid, ["ui", "button", name]);
  }

  /** The screen size in points and the scale, from `idb describe`. */
  async screen(udid: string): Promise<{ width: number; height: number; scale: number } | null> {
    try {
      const out = await this.idb(udid, ["describe", "--json"]);
      const dims = (JSON.parse(out) as { screen_dimensions?: Record<string, number> })
        .screen_dimensions;
      if (!dims) return null;
      return {
        width: dims.width_points ?? dims.width,
        height: dims.height_points ?? dims.height,
        scale: dims.density ?? 1,
      };
    } catch {
      return null;
    }
  }

  stop(udid: string): void {
    const entry = this.companions.get(udid);
    this.companions.delete(udid);
    void entry?.then((c) => c.child.kill("SIGTERM")).catch(() => undefined);
  }

  stopAll(): void {
    for (const udid of [...this.companions.keys()]) this.stop(udid);
  }
}
