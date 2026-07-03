/**
 * Pure-logic tests for `mapAppMetrics` — the mapper from Electron's raw
 * `app.getAppMetrics()` output to the renderer's process-table shape. No
 * Electron deps (the `getAppMetrics()` wrapper that touches `app` /
 * `webContents` is deliberately excluded), so this runs under `node:test`
 * like the other desktop pure-logic tests.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { mapAppMetrics } from "../src/main/ipc/app-metrics.ts";

/** Minimal `ProcessMetric` factory — only the fields the mapper reads. */
function metric(
  overrides: Partial<Electron.ProcessMetric> & {
    pid: number;
    type: Electron.ProcessMetric["type"];
  },
): Electron.ProcessMetric {
  return {
    creationTime: 0,
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: 0, peakWorkingSetSize: 0 },
    ...overrides,
  } as Electron.ProcessMetric;
}

describe("mapAppMetrics", () => {
  const pidLabels = new Map<number, string>([
    [201, "Dashboard"],
    [202, "Browser tab: Example Domain"],
  ]);

  const raw: Electron.ProcessMetric[] = [
    metric({
      pid: 100,
      type: "Browser",
      cpu: { percentCPUUsage: 3, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 50_000, peakWorkingSetSize: 0 },
    }),
    metric({
      pid: 101,
      type: "GPU",
      cpu: { percentCPUUsage: 1, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 30_000, peakWorkingSetSize: 0 },
    }),
    metric({
      pid: 102,
      type: "Utility",
      serviceName: "network.mojom.NetworkService",
      name: "Network Service",
      cpu: { percentCPUUsage: 0.5, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 10_000, peakWorkingSetSize: 0 },
    }),
    metric({
      pid: 201,
      type: "Tab",
      cpu: { percentCPUUsage: 2, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 80_000, peakWorkingSetSize: 0 },
    }),
    metric({
      pid: 202,
      type: "Tab",
      cpu: { percentCPUUsage: 4, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 40_000, peakWorkingSetSize: 0 },
    }),
    // Tab with no matching pidLabel entry → generic "Renderer".
    metric({
      pid: 203,
      type: "Tab",
      cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 5_000, peakWorkingSetSize: 0 },
    }),
    // Unknown/other type → passed through verbatim.
    metric({ pid: 104, type: "Zygote", memory: { workingSetSize: 2_000, peakWorkingSetSize: 0 } }),
  ];

  const result = mapAppMetrics(raw, pidLabels);

  test("labels each process by type and pidLabels lookup", () => {
    const byPid = new Map(result.processes.map((p) => [p.pid, p.label]));
    assert.equal(byPid.get(100), "Main");
    assert.equal(byPid.get(101), "GPU");
    assert.equal(byPid.get(102), "Network service");
    assert.equal(byPid.get(201), "Dashboard");
    assert.equal(byPid.get(202), "Browser tab: Example Domain");
    assert.equal(byPid.get(203), "Renderer");
    assert.equal(byPid.get(104), "Zygote");
  });

  test("maps cpuPercent and memoryKB from the raw metric", () => {
    const main = result.processes.find((p) => p.pid === 100);
    assert.ok(main);
    assert.equal(main.cpuPercent, 3);
    assert.equal(main.memoryKB, 50_000);
  });

  test("computes totals across all processes", () => {
    assert.equal(result.processCount, 7);
    assert.equal(result.totalMemoryKB, 50_000 + 30_000 + 10_000 + 80_000 + 40_000 + 5_000 + 2_000);
    // 3 + 1 + 0.5 + 2 + 4 + 0 + 0 = 10.5
    assert.equal(result.totalCpuPercent, 10.5);
  });

  test("sorts processes by memoryKB descending", () => {
    const mem = result.processes.map((p) => p.memoryKB);
    const sorted = [...mem].sort((a, b) => b - a);
    assert.deepEqual(mem, sorted);
    // Largest is the 80_000 KB Dashboard tab, smallest the 2_000 KB Zygote.
    assert.equal(result.processes[0].pid, 201);
    assert.equal(result.processes.at(-1)?.pid, 104);
  });

  test("falls back to defaults when cpu/memory are absent", () => {
    const out = mapAppMetrics([{ pid: 1, type: "Utility" } as Electron.ProcessMetric], new Map());
    assert.equal(out.processes[0].cpuPercent, 0);
    assert.equal(out.processes[0].memoryKB, 0);
    assert.equal(out.processes[0].label, "Utility");
  });

  test("unknown Utility serviceName falls back to the localised name", () => {
    const out = mapAppMetrics(
      [metric({ pid: 2, type: "Utility", serviceName: "unknown.mojom.Foo", name: "Foo Service" })],
      new Map(),
    );
    assert.equal(out.processes[0].label, "Foo Service");
  });
});
