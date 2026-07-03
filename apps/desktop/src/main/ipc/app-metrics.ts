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
function labelFor(m: Electron.ProcessMetric, pidLabels: Map<number, string>): string {
  switch (m.type) {
    case "Browser":
      return "Main";
    case "GPU":
      return "GPU";
    case "Utility":
      return (m.serviceName && UTILITY_FRIENDLY_NAMES[m.serviceName]) ?? m.name ?? "Utility";
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
export function mapAppMetrics(
  raw: Electron.ProcessMetric[],
  pidLabels: Map<number, string>,
): AppMetrics {
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
 * Build the pid → friendly-name map from live `webContents`. The main
 * dashboard window (a top-level `BrowserWindow`, type `"window"`) is labelled
 * "Dashboard"; every other `webContents` is a browser-tab `WebContentsView`
 * and gets `Browser tab: <title or url>`.
 *
 * `getOSProcessId()` throws if the renderer has already gone away (a tab
 * closing mid-refresh), so each lookup is guarded.
 */
function buildPidLabels(allWebContents: Electron.WebContents[]): Map<number, string> {
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
      pidLabels.set(pid, "Dashboard");
    } else {
      const title = wc.getTitle() || wc.getURL();
      pidLabels.set(pid, title ? `Browser tab: ${title}` : "Browser tab");
    }
  }
  return pidLabels;
}

/**
 * Gather the live Electron/Chromium process metrics for the renderer.
 * `electron` is imported lazily (see the module header) so this file stays
 * loadable under `node:test`.
 */
export async function getAppMetrics(): Promise<AppMetrics> {
  const { app, webContents } = await import("electron");
  return mapAppMetrics(app.getAppMetrics(), buildPidLabels(webContents.getAllWebContents()));
}
