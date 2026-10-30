import { readFile, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { defineWorkerPlugin } from "@band-app/plugin-api/worker";
import { DeviceSet, maxBooted } from "./devices.ts";
import { Input } from "./input.ts";
import { run } from "./tools.ts";

const BUTTONS = ["HOME", "LOCK", "SIDE_BUTTON", "APPLE_PAY", "SIRI"] as const;

function obj(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

function str(params: unknown, key: string): string {
  const v = obj(params)[key];
  if (typeof v !== "string" || v === "") throw new Error(`${key} must be a non-empty string`);
  return v;
}

function num(params: unknown, key: string): number {
  const v = obj(params)[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
  return v;
}

/** Width and height in pixels, from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * The worker half of the simulator plugin. Every worktree gets one device in a Band-owned device
 * set (`<state dir>/simulator/devices`), so the user's own simulators are never touched.
 */
export default defineWorkerPlugin({
  id: "simulator",
  create(api) {
    const root = join(api.stateDir, "simulator");
    const devices = new DeviceSet(join(root, "devices"));
    const input = new Input(devices.dir);
    devices.onShutdown = (udid) => input.stop(udid);

    return {
      async unavailable() {
        try {
          await run("xcrun", ["simctl", "help"], { timeoutMs: 20_000 });
          return null;
        } catch {
          return "xcrun simctl does not run (is Xcode installed?)";
        }
      },

      async call(method, params, { worktreeKey, worktreePath }) {
        // Every call that boots a device queues behind the others, so the cap holds.
        const boot = () => devices.exclusive(() => devices.ensureBooted(worktreeKey));
        switch (method) {
          case "status": {
            const device = await devices.exclusive(() => devices.ensureDevice(worktreeKey));
            const screen = device.state === "Booted" ? await input.screen(device.udid) : null;
            return {
              udid: device.udid,
              name: device.name,
              state: device.state,
              screen,
              maxBooted: maxBooted(),
              input: input.available(),
            };
          }
          case "screenshot": {
            const device = await boot();
            const file = join(root, `shot-${device.udid}-${Date.now()}.png`);
            try {
              await run("xcrun", [
                "simctl",
                "--set",
                devices.dir,
                "io",
                device.udid,
                "screenshot",
                "--type=png",
                file,
              ]);
              const png = await readFile(file);
              return { pngBase64: png.toString("base64"), ...pngSize(png) };
            } finally {
              await rm(file, { force: true });
            }
          }
          case "tap": {
            const device = await boot();
            await input.tap(device.udid, num(params, "x"), num(params, "y"));
            return { ok: true };
          }
          case "type": {
            const device = await boot();
            await input.type(device.udid, str(params, "text"));
            return { ok: true };
          }
          case "button": {
            const name = str(params, "button");
            if (!(BUTTONS as readonly string[]).includes(name)) {
              throw new Error(`button must be one of ${BUTTONS.join(", ")}`);
            }
            const device = await boot();
            await input.button(device.udid, name);
            return { ok: true };
          }
          case "openUrl": {
            const device = await boot();
            await run("xcrun", [
              "simctl",
              "--set",
              devices.dir,
              "openurl",
              device.udid,
              str(params, "url"),
            ]);
            return { ok: true };
          }
          case "install": {
            const app = await realpath(str(params, "path")).catch(() => {
              throw new Error(`${str(params, "path")} does not exist`);
            });
            const wt = await realpath(worktreePath);
            if (!app.startsWith(wt + sep) || !app.endsWith(".app")) {
              throw new Error("path must be an .app folder inside this worktree");
            }
            const device = await boot();
            await run("xcrun", ["simctl", "--set", devices.dir, "install", device.udid, app], {
              timeoutMs: 5 * 60_000,
            });
            return { ok: true };
          }
          case "launch": {
            const device = await boot();
            const { stdout } = await run("xcrun", [
              "simctl",
              "--set",
              devices.dir,
              "launch",
              device.udid,
              str(params, "bundleId"),
            ]);
            return { output: stdout.trim() };
          }
          default:
            throw new Error(`unknown simulator method ${method}`);
        }
      },

      async release(worktreeKey, reason) {
        await devices.exclusive(() =>
          reason === "removed"
            ? devices.deleteWorktree(worktreeKey)
            : devices.shutdownWorktree(worktreeKey),
        );
      },

      async stop() {
        await devices.exclusive(() => devices.shutdownAll());
        input.stopAll();
      },
    };
  },
});
