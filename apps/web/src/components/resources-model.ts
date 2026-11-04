import type { AppRouter } from "@band-app/server";
import type { inferRouterOutputs } from "@trpc/server";

type Outputs = inferRouterOutputs<AppRouter>;
export type HubMachine = Outputs["resources"]["snapshot"]["machines"][number];
export type StorageView = Outputs["resources"]["storage"];
export type ProcessView = NonNullable<HubMachine["snapshot"]>["processes"][number];
export type Metric = "memory" | "cpu" | "storage";

// Mirrors the mapper output in apps/desktop/src/main/ipc/app-metrics.ts. Defined here, not
// imported, so the web app has no build-time dependency on desktop types.
export interface AppProcessMetric {
  pid: number;
  label: string;
  type: string;
  cpuPercent: number;
  memoryKB: number;
}

export interface AppMetrics {
  processCount: number;
  totalMemoryKB: number;
  totalCpuPercent: number;
  processes: AppProcessMetric[];
}

/** A machine card: a hub or worker from the server, or the desktop app's Electron processes. */
export type Machine = Omit<HubMachine, "role" | "snapshot"> & {
  role: "hub" | "worker" | "app";
  kind?: "app";
  snapshot: {
    hostname: string;
    cores: number;
    memTotalBytes: number;
    memUsedBytes: number;
    machineCpuPercent: number | null;
    processes: ProcessView[];
  } | null;
};

export type GroupId = "host" | "agents" | "terminals" | "lsp" | "browsers" | "other";

export const GROUP_META: Record<GroupId, { swatch: string; label: (m: Machine) => string }> = {
  host: {
    swatch: "bg-chart-1",
    label: (m) =>
      m.role === "hub"
        ? "Hub server"
        : m.role === "app"
          ? "Dashboard, main, GPU, helpers"
          : "band-worker",
  },
  agents: { swatch: "bg-chart-4", label: () => "Agents" },
  terminals: { swatch: "bg-success", label: () => "Terminals" },
  lsp: { swatch: "bg-chart-2", label: () => "Language servers" },
  browsers: {
    swatch: "bg-chart-5",
    label: (m) => (m.role === "app" ? "Browser tabs" : "Browsers, simulators, MCP"),
  },
  other: { swatch: "bg-muted-foreground", label: () => "Other" },
};

const GROUP_ORDER: GroupId[] = ["host", "agents", "terminals", "lsp", "browsers", "other"];

export function groupOf(kind: string): GroupId {
  switch (kind) {
    case "worker":
    case "hub":
    case "app":
      return "host";
    case "agent":
    case "agent-daemon":
      return "agents";
    case "terminal":
    case "terminal-daemon":
      return "terminals";
    case "lsp":
      return "lsp";
    case "browser":
    case "simulator":
    case "mcp":
      return "browsers";
    default:
      return "other";
  }
}

export function groupProcesses(
  processes: ProcessView[],
): { id: GroupId; processes: ProcessView[] }[] {
  const map = new Map<GroupId, ProcessView[]>();
  for (const p of processes) {
    const id = groupOf(p.kind);
    map.set(id, [...(map.get(id) ?? []), p]);
  }
  return GROUP_ORDER.filter((id) => map.has(id)).map((id) => ({
    id,
    processes: map.get(id) as ProcessView[],
  }));
}

export function metricOf(processes: ProcessView[], metric: Metric): number {
  return processes.reduce((n, p) => n + (metric === "cpu" ? p.cpuPercent : p.rssBytes), 0);
}

export function topConsumers(
  machines: Machine[],
  limit: number,
): { machine: Machine; proc: ProcessView; group: GroupId }[] {
  const rows = machines.flatMap((machine) =>
    (machine.snapshot?.processes ?? []).map((proc) => ({
      machine,
      proc,
      group: groupOf(proc.kind),
    })),
  );
  return rows.sort((a, b) => b.proc.cpuPercent - a.proc.cpuPercent).slice(0, limit);
}

const MB = 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < MB * 1024) return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
  return `${(bytes / (MB * 1024)).toFixed(bytes < 10 * MB * 1024 ? 2 : 1)} GB`;
}

export function formatCpu(percent: number): string {
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/** The desktop app's Electron processes as a machine, shown beside the hub and the workers. */
export function appMachine(metrics: AppMetrics | undefined): Machine | null {
  if (!metrics) return null;
  const processes: ProcessView[] = metrics.processes.map((p) => ({
    pid: p.pid,
    kind: /tab/i.test(p.type) ? "browser" : "app",
    name: p.label || p.type,
    rssBytes: p.memoryKB * 1024,
    cpuPercent: p.cpuPercent,
    processCount: 1,
  })) as ProcessView[];
  return {
    id: "desktop-app",
    role: "app",
    kind: "app",
    name: "Desktop app",
    version: null,
    builtInWorker: false,
    onBattery: null,
    status: "ok",
    reason: null,
    snapshot: {
      hostname: "this device",
      cores: 0,
      memTotalBytes: 0,
      memUsedBytes: 0,
      machineCpuPercent: null,
      processes,
    },
  };
}
