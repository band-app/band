import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { defineWorkerPlugin } from "@band-app/plugin-api/worker";
import { DeviceSet, maxBooted } from "./devices.ts";
import { ServeSimHelpers } from "./servesim.ts";
import { openScreenStream, serveSimButton } from "./stream.ts";
import { run } from "./tools.ts";

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
 * The worker half of the simulator plugin. Every worktree gets one device named
 * "Band – <worktree id>" in the machine's default device set, where serve-sim can see it.
 * Only devices with that name prefix are ever touched.
 */
export default defineWorkerPlugin({
  id: "simulator",
  create(api) {
    const root = join(api.stateDir, "simulator");
    const devices = new DeviceSet(join(root, "devices"));
    const helpers = new ServeSimHelpers();
    devices.onShutdown = (udid) => {
      void helpers.stop(udid);
    };

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
            const screen = device.state === "Booted" ? await helpers.screen(device.udid) : null;
            return {
              udid: device.udid,
              name: device.name,
              state: device.state,
              screen,
              maxBooted: maxBooted(),
            };
          }
          case "boot": {
            const device = await boot();
            return { udid: device.udid, name: device.name, state: device.state };
          }
          case "screenshot": {
            const device = await boot();
            await mkdir(root, { recursive: true });
            const file = join(root, `shot-${device.udid}-${Date.now()}.png`);
            try {
              await run("xcrun", ["simctl", "io", device.udid, "screenshot", "--type=png", file]);
              const png = await readFile(file);
              const screen = await helpers.screen(device.udid);
              const { width, height } = pngSize(png);
              return {
                pngBase64: png.toString("base64"),
                width,
                height,
                scale: screen ? Math.round((width / screen.width) * 100) / 100 : null,
              };
            } finally {
              await rm(file, { force: true });
            }
          }
          case "describe": {
            const device = await boot();
            return helpers.describe(device.udid);
          }
          case "tap": {
            const device = await boot();
            await helpers.tap(device.udid, num(params, "x"), num(params, "y"));
            return { ok: true };
          }
          case "type": {
            const device = await boot();
            await helpers.type(device.udid, str(params, "text"));
            return { ok: true };
          }
          case "button": {
            const name = serveSimButton(str(params, "button"));
            const device = await boot();
            await helpers.button(device.udid, name);
            return { ok: true };
          }
          case "openUrl": {
            const device = await boot();
            await run("xcrun", ["simctl", "openurl", device.udid, str(params, "url")]);
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
            await run("xcrun", ["simctl", "install", device.udid, app], {
              timeoutMs: 5 * 60_000,
            });
            return { ok: true };
          }
          case "launch": {
            const device = await boot();
            const { stdout } = await run("xcrun", [
              "simctl",
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

      async stream(name, params, { worktreeKey }) {
        if (name !== "screen") throw new Error(`unknown simulator stream ${name}`);
        const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
        const helper = await helpers.helper(device.udid);
        const screen = (await helpers.screen(device.udid)) ?? { width: 0, height: 0 };
        return openScreenStream(
          helper,
          helpers,
          {
            ...screen,
            udid: device.udid,
            name: device.name,
          },
          params,
        );
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
        await helpers.stopAll();
      },
    };
  },
});
