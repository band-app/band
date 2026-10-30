import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { run } from "./tools.ts";

/** One serve-sim helper: the process that captures a booted device and takes HID input for it. */
export interface Helper {
  udid: string;
  port: number;
  streamUrl: string;
  wsUrl: string;
  axUrl: string;
}

export interface Screen {
  /** Width and height in points. */
  width: number;
  height: number;
}

/** One element of the screen's accessibility tree, flattened. Coordinates are points. */
export interface DescribedElement {
  type: string;
  label?: string;
  value?: string;
  id?: string;
  enabled: boolean;
  frame: { x: number; y: number; width: number; height: number };
  /** Where to tap it: the frame's center. */
  center: { x: number; y: number };
}

interface AxNode {
  type?: string;
  role_description?: string;
  AXLabel?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  enabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  children?: AxNode[];
}

/** The serve-sim pinned by the worker. Its CLI is the one entry point, and it is a Node script. */
function serveSimEntry(): string {
  const override = process.env.BAND_SERVE_SIM_ENTRY;
  if (override) return override;
  // The package exports only its middleware, which sits in the same dist folder as the CLI.
  const middleware = createRequire(import.meta.url).resolve("serve-sim/middleware");
  return join(dirname(middleware), "serve-sim.js");
}

/** Runs the serve-sim CLI with this process's own Node (Electron runs as Node in the desktop app). */
function serveSim(args: string[], options: { stdin?: string; timeoutMs?: number } = {}) {
  return run(process.execPath, [serveSimEntry(), ...args], {
    ...options,
    // The helper outlives the call and runs third-party code, so it gets no Band or credential variables.
    env: childEnv(),
  });
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "DEVELOPER_DIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Keeps the elements that say or do something, in reading order. */
export function compactTree(roots: AxNode[]): DescribedElement[] {
  const out: DescribedElement[] = [];
  const visit = (node: AxNode) => {
    const label = node.AXLabel?.trim() || undefined;
    const value = node.AXValue?.trim() || undefined;
    const id = node.AXUniqueId?.trim() || undefined;
    const frame = node.frame;
    const type = node.type ?? node.role_description ?? "Unknown";
    const interactive =
      /^(Button|TextField|SecureTextField|Switch|Slider|Link|Cell|Tab|SearchField)/.test(type);
    if (frame && frame.width > 0 && frame.height > 0 && (label || value || interactive)) {
      out.push({
        type,
        ...(label ? { label } : {}),
        ...(value && value !== label ? { value } : {}),
        ...(id && id !== label ? { id } : {}),
        enabled: node.enabled !== false,
        frame: {
          x: round(frame.x),
          y: round(frame.y),
          width: round(frame.width),
          height: round(frame.height),
        },
        center: { x: round(frame.x + frame.width / 2), y: round(frame.y + frame.height / 2) },
      });
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

/**
 * Capture and input for booted simulators, through serve-sim (npm, pinned by the worker; it drives
 * the simulator's private HID and framebuffer APIs). One detached helper runs per device. The
 * helper serves an MJPEG stream and the accessibility tree over HTTP and takes input on a
 * WebSocket. Starting a helper that already runs returns the running one.
 */
export class ServeSimHelpers {
  private readonly helpers = new Map<string, Promise<Helper>>();

  /** The helper for a booted device, started on first use. */
  helper(udid: string): Promise<Helper> {
    let existing = this.helpers.get(udid);
    if (!existing) {
      existing = this.start(udid);
      this.helpers.set(udid, existing);
      existing.catch(() => this.helpers.delete(udid));
    }
    return existing;
  }

  private async start(udid: string): Promise<Helper> {
    const { stdout } = await serveSim(
      ["--detach", "-q", "--no-preview", "--exit-on-simulator-shutdown", udid],
      { timeoutMs: 90_000 },
    );
    const line = stdout.trim().split("\n").pop() ?? "";
    let info: { port?: unknown; streamUrl?: unknown; wsUrl?: unknown; device?: unknown };
    try {
      info = JSON.parse(line);
    } catch {
      throw new Error(`serve-sim did not report its endpoints: ${line.slice(0, 200)}`);
    }
    if (
      typeof info.port !== "number" ||
      typeof info.streamUrl !== "string" ||
      typeof info.wsUrl !== "string"
    ) {
      throw new Error("serve-sim did not report its endpoints");
    }
    return {
      udid,
      port: info.port,
      streamUrl: info.streamUrl,
      wsUrl: info.wsUrl,
      axUrl: info.streamUrl.replace(/\/stream\.mjpeg$/, "/ax"),
    };
  }

  /** Forgets a helper whose process died, so the next call starts a new one. */
  forget(udid: string): void {
    this.helpers.delete(udid);
  }

  private async tree(udid: string): Promise<AxNode[]> {
    let helper = await this.helper(udid);
    let res: Response;
    try {
      res = await fetch(helper.axUrl, { signal: AbortSignal.timeout(20_000) });
    } catch {
      // The helper died (its device was shut down elsewhere): start a new one once.
      this.forget(udid);
      helper = await this.helper(udid);
      res = await fetch(helper.axUrl, { signal: AbortSignal.timeout(20_000) });
    }
    if (!res.ok) {
      this.forget(udid);
      throw new Error(`serve-sim accessibility request failed: ${res.status}`);
    }
    const body = (await res.json()) as AxNode[] | { error?: string };
    if (!Array.isArray(body)) throw new Error(body.error ?? "Accessibility unavailable");
    return body;
  }

  /** The screen size in points, from the accessibility tree's root. */
  async screen(udid: string): Promise<Screen | null> {
    try {
      const frame = (await this.tree(udid))[0]?.frame;
      return frame ? { width: frame.width, height: frame.height } : null;
    } catch {
      return null;
    }
  }

  async describe(udid: string): Promise<{ screen: Screen | null; elements: DescribedElement[] }> {
    const roots = await this.tree(udid);
    const frame = roots[0]?.frame;
    return {
      screen: frame ? { width: frame.width, height: frame.height } : null,
      elements: compactTree(roots),
    };
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    const screen = await this.screen(udid);
    if (!screen) throw new Error("The screen size is not known yet; try again in a moment");
    if (x < 0 || y < 0 || x > screen.width || y > screen.height) {
      throw new Error(`(${x}, ${y}) is outside the ${screen.width}x${screen.height} point screen`);
    }
    await serveSim(["tap", "-d", udid, String(x / screen.width), String(y / screen.height)]);
  }

  async type(udid: string, text: string): Promise<void> {
    await this.helper(udid);
    await serveSim(["type", "-d", udid, "--stdin"], { stdin: text });
  }

  async button(udid: string, name: string): Promise<void> {
    await this.helper(udid);
    await serveSim(["button", "-d", udid, name]);
  }

  async rotate(udid: string, orientation: string): Promise<void> {
    await this.helper(udid);
    await serveSim(["rotate", "-d", udid, orientation]);
  }

  /** Stops the device's helper. */
  async stop(udid: string): Promise<void> {
    this.helpers.delete(udid);
    await serveSim(["--kill", udid], { timeoutMs: 20_000 }).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    const udids = [...this.helpers.keys()];
    this.helpers.clear();
    await Promise.all(
      udids.map((udid) => serveSim(["--kill", udid], { timeoutMs: 20_000 }).catch(() => undefined)),
    );
  }
}
