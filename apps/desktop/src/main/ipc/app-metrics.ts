/**
 * `get_app_metrics` — per-process Electron/Chromium resource stats.
 *
 * Surfaces what `app.getAppMetrics()` reports: the Electron main (Browser)
 * process, the GPU process, each Chromium renderer (the dashboard webview
 * plus every browser-tab `WebContentsView`), and the Utility processes
 * (network service, audio, storage, helpers). The web server has no
 * visibility into any of this — it's all Electron-side — so this lives on
 * the desktop side and is rendered by a self-gating card in the renderer.
 *
 * The mapping from raw `ProcessMetric` to the renderer's shape is a PURE
 * function (`mapAppMetrics`) so it can be unit-tested without booting
 * Electron; only `getAppMetrics()` touches `app` / `webContents`, and it
 * imports them lazily so `node:test` can load this module without the
 * `electron` package (whose top-level `import` throws outside the Electron
 * runtime) — same testability split as `save-helpers.ts`.
 */

// Type-only import — erased at compile time, so it does NOT reintroduce the
// runtime `electron` dependency the module header is careful to avoid (that's
// why `getAppMetrics` still imports `app`/`webContents` lazily below).
import type { ProcessMetric, WebContents } from "electron";

/** One Electron/Chromium process, flattened for the renderer table. */
export interface AppProcessMetric {
  pid: number;
  /** Friendly label, e.g. "Main", "GPU", "Dashboard", "Browser tab: …". */
  label: string;
  /** Raw Electron process type ("Browser", "Tab", "Utility", "GPU", …). */
  type: string;
  cpuPercent: number;
  /** Working-set size in KB (as Electron reports it). */
  memoryKB: number;
}

/** Aggregate snapshot returned to the renderer. */
export interface AppMetrics {
  processCount: number;
  totalMemoryKB: number;
  totalCpuPercent: number;
  /** Processes sorted by `memoryKB` descending. */
  processes: AppProcessMetric[];
}

/**
 * Friendly names for the Utility processes we recognise. Keyed by the
 * non-localised `serviceName` (e.g. `network.mojom.NetworkService`) so the
 * label is stable across locales. Anything not in the map falls back to the
 * localised `name`, then a bare "Utility".
 */
const UTILITY_FRIENDLY_NAMES: Record<string, string> = {
  "network.mojom.NetworkService": "Network service",
  "storage.mojom.StorageService": "Storage service",
  "audio.mojom.AudioService": "Audio service",
  "video_capture.mojom.VideoCaptureService": "Video capture service",
  "data_decoder.mojom.DataDecoderService": "Data decoder service",
  "tracing.mojom.TracingService": "Tracing service",
};

/**
 * Compute the display label for a single process metric.
 *
 * `pidLabels` carries renderer-specific names resolved from live
 * `webContents` (the dashboard window, each browser tab) — only "Tab"
 * processes look themselves up there.
 */
function labelFor(m: ProcessMetric, pidLabels: Map<number, string>): string {
  switch (m.type) {
    case "Browser":
      return "Main";
    case "GPU":
      return "GPU";
    case "Utility":
      // `serviceName` first (locale-stable), then the localised `name`. Guard
      // with a truthiness check rather than `&& … ?? …`: an empty-string
      // `serviceName` is falsy-but-not-nullish, so `?? m.name` wouldn't catch
      // it and we'd render a blank label.
      return m.serviceName
        ? (UTILITY_FRIENDLY_NAMES[m.serviceName] ?? m.name ?? "Utility")
        : (m.name ?? "Utility");
    case "Tab":
      return pidLabels.get(m.pid) ?? "Renderer";
    default:
      // Zygote, Sandbox helper, Pepper Plugin, Unknown, … — the raw type
      // is already the most useful thing we can show.
      return m.type;
  }
}

/**
 * Pure mapper from Electron's raw `ProcessMetric[]` to the renderer shape.
 * Exported so it can be tested without Electron.
 */
export function mapAppMetrics(raw: ProcessMetric[], pidLabels: Map<number, string>): AppMetrics {
  const processes: AppProcessMetric[] = raw.map((m) => ({
    pid: m.pid,
    label: labelFor(m, pidLabels),
    type: m.type,
    cpuPercent: m.cpu?.percentCPUUsage ?? 0,
    memoryKB: m.memory?.workingSetSize ?? 0,
  }));

  processes.sort((a, b) => b.memoryKB - a.memoryKB);

  return {
    processCount: processes.length,
    totalMemoryKB: processes.reduce((sum, p) => sum + p.memoryKB, 0),
    totalCpuPercent: processes.reduce((sum, p) => sum + p.cpuPercent, 0),
    processes,
  };
}

/**
 * Build the pid → friendly-name map from live `webContents`. Labels:
 *
 *   - `"Dashboard"` — only the real dashboard window, matched by its
 *     `webContents.id` (`dashboardWcId`). Other top-level `BrowserWindow`s
 *     (type `"window"`) — e.g. the hidden CDP-parking window created when the
 *     screencast experiment is on — are labelled `"Window"` so they aren't
 *     mistaken for the dashboard.
 *   - `"DevTools"` — a docked DevTools view, recognised by its
 *     `devtools://` URL (these are non-`"window"` `WebContentsView`s that
 *     would otherwise be mislabelled as browser tabs).
 *   - `"Browser tab: <title or url>"` — every other `WebContentsView`.
 *
 * `getOSProcessId()` throws if the renderer has already gone away (a tab
 * closing mid-refresh), so each lookup is guarded.
 */
function buildPidLabels(allWebContents: WebContents[], dashboardWcId: number): Map<number, string> {
  const pidLabels = new Map<number, string>();
  for (const wc of allWebContents) {
    let pid: number;
    try {
      pid = wc.getOSProcessId();
    } catch {
      continue;
    }
    if (!pid) continue;
    if (wc.getType() === "window") {
      pidLabels.set(pid, wc.id === dashboardWcId ? "Dashboard" : "Window");
      continue;
    }
    const url = wc.getURL();
    if (url.startsWith("devtools://")) {
      pidLabels.set(pid, "DevTools");
      continue;
    }
    const title = wc.getTitle() || url;
    pidLabels.set(pid, title ? `Browser tab: ${title}` : "Browser tab");
  }
  return pidLabels;
}

/**
 * Gather the live Electron/Chromium process metrics for the renderer.
 * `electron` is imported lazily (see the module header) so this file stays
 * loadable under `node:test`. `dashboardWcId` is the main window's
 * `webContents.id`, passed in from `register.ts` so the mapper can single out
 * the real dashboard renderer from other top-level windows.
 */
export async function getAppMetrics(dashboardWcId: number): Promise<AppMetrics> {
  const { app, webContents } = await import("electron");
  return mapAppMetrics(
    app.getAppMetrics(),
    buildPidLabels(webContents.getAllWebContents(), dashboardWcId),
  );
}
