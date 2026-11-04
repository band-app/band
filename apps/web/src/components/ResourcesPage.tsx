import { Button, Spinner } from "@band-app/ui";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { invoke } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import { usePollInterval } from "../lib/poll-interval";
import { trpc } from "../lib/trpc-client";
import {
  type AppMetrics,
  appMachine,
  formatBytes,
  formatCpu,
  GROUP_META,
  type GroupId,
  groupProcesses,
  type Machine,
  type Metric,
  metricOf,
  type ProcessView,
  type StorageView,
  topConsumers,
} from "./resources-model";

const METRICS: { id: Metric; label: string }[] = [
  { id: "memory", label: "Memory" },
  { id: "cpu", label: "CPU" },
  { id: "storage", label: "Storage" },
];

/** Rows shown in a group before the rest fold into one "N more" row. */
const ROWS_SHOWN = 8;
const REFRESH_MS = 5_000;

function fmt(metric: Metric, value: number): string {
  return metric === "cpu" ? formatCpu(value) : formatBytes(value);
}

export function ResourcesPage({ onNavigate }: { onNavigate?: () => void }) {
  return <ResourcesBody onNavigate={onNavigate} />;
}

function ResourcesBody({ onNavigate }: { onNavigate?: () => void }) {
  const metricState = useMetric();
  const [metric, setMetric] = metricState;
  const poll = usePollInterval(REFRESH_MS);
  const snapshot = useQuery({
    queryKey: ["resources", "snapshot"],
    queryFn: () => trpc.resources.snapshot.query(),
    refetchInterval: metric === "storage" ? false : poll,
  });
  const appMetrics = useQuery<AppMetrics>({
    queryKey: ["resources", "app-metrics"],
    queryFn: () => invoke<AppMetrics>("get_app_metrics"),
    enabled: isDesktop && metric !== "storage",
    refetchInterval: metric === "storage" ? false : poll,
  });

  const machines: Machine[] = snapshot.data?.machines ?? [];
  const okIds = machines.filter((m) => m.status === "ok").map((m) => m.id);
  const storage = useQueries({
    queries: okIds.map((hostId) => ({
      queryKey: ["resources", "storage", hostId],
      queryFn: () => trpc.resources.storage.query({ hostId }),
      enabled: metric === "storage",
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    })),
  });
  const storageById = new Map<string, (typeof storage)[number]>(
    okIds.map((id, i) => [id, storage[i]]),
  );
  const app = isDesktop && metric !== "storage" ? appMachine(appMetrics.data) : null;

  const refreshing = snapshot.isFetching || storage.some((q) => q.isFetching);
  const refresh = () => {
    void snapshot.refetch();
    if (isDesktop) void appMetrics.refetch();
    for (const q of storage) void q.refetch();
  };

  return (
    <div className="flex h-full flex-col" data-testid="resources__page">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/50 px-4 py-3 sm:px-6">
        <span className="text-xs text-muted-foreground" data-testid="resources__updated">
          {snapshot.data
            ? `Updated ${new Date(snapshot.data.takenAt).toLocaleTimeString()}`
            : "Loading…"}
          {metric === "storage" ? "" : " · refreshes every 5 s while open"}
        </span>
        <div className="flex-1" />
        <div
          role="tablist"
          aria-label="Metric"
          className="inline-flex overflow-hidden rounded-lg border border-border"
        >
          {METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={metric === m.id}
              data-testid={`resources__tab-${m.id}`}
              onClick={() => setMetric(m.id)}
              className="px-3.5 py-1.5 text-sm text-muted-foreground aria-selected:bg-muted aria-selected:font-semibold aria-selected:text-foreground"
            >
              {m.label}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Refresh"
          title="Refresh"
          data-testid="resources__refresh"
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 sm:px-6">
        {snapshot.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Failed to load resources: {String(snapshot.error)}
          </p>
        ) : !snapshot.data ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading…
          </div>
        ) : (
          <>
            <div
              className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2.5"
              data-testid="resources__cards"
            >
              {[...machines, ...(app ? [app] : [])].map((m) => (
                <MachineCard
                  key={m.id}
                  machine={m}
                  metric={metric}
                  storage={storageById.get(m.id)?.data}
                />
              ))}
            </div>
            {metric === "cpu" && <TopConsumers machines={machines} onNavigate={onNavigate} />}
            {[...machines, ...(app ? [app] : [])].map((m) => (
              <MachineSection
                key={m.id}
                machine={m}
                metric={metric}
                storage={storageById.get(m.id)}
                onNavigate={onNavigate}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function useMetric() {
  return useState<Metric>("memory");
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function StatusDot({ machine }: { machine: Machine }) {
  return (
    <span
      aria-hidden="true"
      className={`size-2 shrink-0 rounded-full ${machine.status === "ok" ? "bg-success" : "bg-muted-foreground/50"}`}
    />
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

function MachineCard({
  machine,
  metric,
  storage,
}: {
  machine: Machine;
  metric: Metric;
  storage: StorageView | undefined;
}) {
  const snap = machine.snapshot;
  const groups = snap ? groupProcesses(snap.processes) : [];
  let big = "–";
  let sub = "";
  let capacity = 0;
  if (snap) {
    const isApp = machine.role === "app";
    if (metric === "memory") {
      const sum = snap.processes.reduce((n, p) => n + p.rssBytes, 0);
      big = formatBytes(sum);
      sub = isApp
        ? `${snap.processes.length} Electron processes`
        : `Band processes · machine ${formatBytes(snap.memUsedBytes)} of ${formatBytes(snap.memTotalBytes)}`;
      capacity = isApp ? sum : snap.memTotalBytes;
    } else if (metric === "cpu") {
      const sum = snap.processes.reduce((n, p) => n + p.cpuPercent, 0);
      big = formatCpu(sum);
      sub = isApp
        ? `${snap.processes.length} Electron processes`
        : `of ${snap.cores * 100}%${snap.machineCpuPercent === null ? "" : ` · machine ${Math.round(snap.machineCpuPercent)}%`}`;
      capacity = isApp ? Math.max(sum, 1) : snap.cores * 100;
    } else if (storage) {
      const used =
        storage.worktrees.reduce((n, w) => n + w.sizeBytes, 0) +
        storage.state.reduce((n, s) => n + s.sizeBytes, 0);
      big = formatBytes(used);
      sub = storage.disk
        ? `worktrees + state · ${formatBytes(storage.disk.freeBytes)} free`
        : "worktrees + state";
      capacity = storage.disk?.totalBytes ?? used;
    } else {
      sub = "Measuring…";
    }
  }
  return (
    <div
      className="rounded-xl border border-border bg-muted/30 p-3"
      data-testid={`resources__card-${machine.id}`}
      data-status={machine.status}
    >
      <div className="flex items-center gap-1.5">
        <StatusDot machine={machine} />
        <span className="truncate font-semibold">{machine.name}</span>
        <Tag>{machine.role === "hub" ? "hub" : machine.role === "app" ? "Electron" : "worker"}</Tag>
        {machine.version && <Tag>{machine.version}</Tag>}
      </div>
      {machine.status === "unavailable" ? (
        <div
          className="mt-1.5 text-sm text-muted-foreground"
          data-testid={`resources__unavailable-${machine.id}`}
        >
          Unavailable ·{" "}
          {machine.reason === "offline"
            ? "the worker is offline"
            : "the worker did not answer in time"}
        </div>
      ) : (
        <>
          <div
            className="mt-1.5 text-xl font-semibold"
            data-testid={`resources__card-total-${machine.id}`}
          >
            {big}
          </div>
          <div className="text-xs text-muted-foreground">{sub}</div>
          {metric !== "storage" && capacity > 0 && (
            <StackBar
              segments={groups.map((g) => ({
                id: g.id,
                pct: (metricOf(g.processes, metric) / capacity) * 100,
              }))}
            />
          )}
        </>
      )}
    </div>
  );
}

function StackBar({ segments }: { segments: { id: GroupId; pct: number }[] }) {
  return (
    <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted">
      {segments.map((s) => (
        <span
          key={s.id}
          className={`block h-full ${GROUP_META[s.id].swatch}`}
          style={{ width: `${Math.min(100, Math.max(0, s.pct))}%` }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function Row({
  swatch,
  children,
  value,
  barPct,
  barClass,
  testId,
  attrs,
}: {
  swatch?: string;
  children: ReactNode;
  value: string;
  barPct?: number;
  barClass?: string;
  testId?: string;
  attrs?: Record<string, string>;
}) {
  return (
    <div
      className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-1.5 text-sm hover:bg-muted/40 sm:grid-cols-[14px_minmax(0,1fr)_120px_90px]"
      data-testid={testId}
      {...attrs}
    >
      <span className={`size-2 rounded-sm ${swatch ?? ""}`} />
      <span className="min-w-0 truncate">{children}</span>
      <span
        className="hidden h-1.5 overflow-hidden rounded-full bg-muted sm:block"
        data-testid="resources__bar"
      >
        {barPct !== undefined && (
          <span
            className={`block h-full rounded-full ${barClass ?? "bg-muted-foreground"}`}
            style={{ width: `${Math.min(100, Math.max(0, barPct))}%` }}
          />
        )}
      </span>
      <span className="text-right font-mono text-xs tabular-nums" data-testid="resources__value">
        {value}
      </span>
    </div>
  );
}

function Ctx({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground"> · {children}</span>;
}

function WorktreeLink({ p, onNavigate }: { p: ProcessView; onNavigate?: () => void }) {
  if (!p.worktree) return null;
  const label = `${p.worktree.repo} ${p.worktree.title ?? p.worktree.branch}`;
  return (
    <Link
      to="/worktree/$worktreeId"
      params={{ worktreeId: p.worktree.id }}
      onClick={onNavigate}
      className="text-primary hover:underline"
      data-testid="resources__worktree-link"
    >
      {label}
    </Link>
  );
}

/** The agent's name from its coding-agent id, such as `claude-code` to `Claude Code`. */
function agentLabel(id: string): string {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function ProcessLabel({ p, onNavigate }: { p: ProcessView; onNavigate?: () => void }) {
  return (
    <>
      {p.kind === "agent" && p.chat ? agentLabel(p.chat.agent) : p.name}
      {p.worktree && (
        <>
          {" · "}
          <WorktreeLink p={p} onNavigate={onNavigate} />
        </>
      )}
      {p.chat && (
        <Ctx>
          <span data-testid="resources__chat">chat “{p.chat.name}”</span>
          {p.chat.running ? " · running" : ""}
        </Ctx>
      )}
      {p.chat?.idle && p.chat.idleMs !== null && (
        <span
          className="ml-1.5 rounded-full border border-warning/50 px-1.5 text-[11px] text-warning"
          data-testid="resources__idle-pill"
        >
          idle {Math.round(p.chat.idleMs / 3_600_000)} h
        </span>
      )}
      {p.processCount > 1 && <Ctx>{p.processCount} processes</Ctx>}
      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground/70">pid {p.pid}</span>
    </>
  );
}

function MachineSection({
  machine,
  metric,
  storage,
  onNavigate,
}: {
  machine: Machine;
  metric: Metric;
  storage: { data?: StorageView; isLoading: boolean; isError: boolean; error: unknown } | undefined;
  onNavigate?: () => void;
}) {
  const snap = machine.snapshot;
  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-muted/30"
      data-testid={`resources__machine-${machine.id}`}
      data-status={machine.status}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
        <StatusDot machine={machine} />
        <span className="font-semibold">{machine.name}</span>
        {snap && machine.role !== "app" && <Tag>{snap.hostname}</Tag>}
        {snap && metric !== "storage" && machine.role !== "app" && (
          <Tag>
            {metric === "memory" ? `${formatBytes(snap.memTotalBytes)} RAM` : `${snap.cores} cores`}
          </Tag>
        )}
        {machine.onBattery && <Tag>on battery</Tag>}
        {machine.builtInWorker && <Tag>runs the built-in worker</Tag>}
        {snap && metric !== "storage" && (
          <span className="ml-auto font-semibold">
            {fmt(metric, metricOf(snap.processes, metric))}
          </span>
        )}
      </div>
      {machine.status === "unavailable" ? (
        <div className="px-3.5 py-2.5 text-sm text-muted-foreground">
          Unavailable ·{" "}
          {machine.reason === "offline"
            ? "the worker is offline"
            : "the worker did not answer in time"}
        </div>
      ) : metric === "storage" ? (
        <StorageBody machine={machine} storage={storage} />
      ) : snap ? (
        <ProcessGroups machine={machine} metric={metric} onNavigate={onNavigate} />
      ) : null}
    </section>
  );
}

function ProcessGroups({
  machine,
  metric,
  onNavigate,
}: {
  machine: Machine;
  metric: Metric;
  onNavigate?: () => void;
}) {
  const snap = machine.snapshot;
  if (!snap) return null;
  const groups = groupProcesses(snap.processes);
  return (
    <>
      {groups.map((g) => {
        const total = metricOf(g.processes, metric);
        const sorted = [...g.processes].sort(
          (a, b) => metricOf([b], metric) - metricOf([a], metric),
        );
        const shown = sorted.slice(0, ROWS_SHOWN);
        const rest = sorted.slice(ROWS_SHOWN);
        const max = Math.max(1, ...sorted.map((p) => metricOf([p], metric)));
        return (
          <details
            key={g.id}
            className="group border-b border-border last:border-b-0"
            open={g.id === "agents" || g.id === "terminals"}
            data-testid={`resources__group-${machine.id}-${g.id}`}
          >
            <summary className="grid cursor-pointer list-none grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-2 sm:grid-cols-[14px_minmax(0,1fr)_120px_90px] [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
              <span className="flex min-w-0 items-center gap-2">
                <span className={`size-2 shrink-0 rounded-sm ${GROUP_META[g.id].swatch}`} />
                <b className="font-semibold">{GROUP_META[g.id].label(machine)}</b>
                <span className="truncate text-xs text-muted-foreground">{g.processes.length}</span>
              </span>
              <span className="hidden h-1.5 overflow-hidden rounded-full bg-muted sm:block">
                <span
                  className={`block h-full rounded-full ${GROUP_META[g.id].swatch}`}
                  style={{
                    width: `${Math.min(100, (total / Math.max(1, metricOf(snap.processes, metric))) * 100)}%`,
                  }}
                />
              </span>
              <span
                className="text-right text-sm font-medium tabular-nums"
                data-testid="resources__group-total"
              >
                {fmt(metric, total)}
              </span>
            </summary>
            <div>
              {shown.map((p) => (
                <Row
                  key={p.pid}
                  swatch={GROUP_META[g.id].swatch}
                  barPct={(metricOf([p], metric) / max) * 100}
                  barClass={GROUP_META[g.id].swatch}
                  value={fmt(metric, metricOf([p], metric))}
                  testId="resources__process"
                  attrs={{
                    "data-kind": p.kind,
                    "data-pid": String(p.pid),
                    "data-machine": machine.id,
                  }}
                >
                  <ProcessLabel p={p} onNavigate={onNavigate} />
                </Row>
              ))}
              {rest.length > 0 && (
                <Row value={fmt(metric, metricOf(rest, metric))}>
                  <span className="text-muted-foreground">{rest.length} more</span>
                </Row>
              )}
            </div>
          </details>
        );
      })}
    </>
  );
}

function TopConsumers({ machines, onNavigate }: { machines: Machine[]; onNavigate?: () => void }) {
  const rows = topConsumers(machines, 8);
  const max = Math.max(1, ...rows.map((r) => r.proc.cpuPercent));
  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-muted/30"
      data-testid="resources__top-consumers"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span className="font-semibold">Top consumers, all machines</span>
        <Tag>sorted by CPU now</Tag>
        <span className="ml-auto text-xs text-muted-foreground">averaged over about 0.5 s</span>
      </div>
      {rows.map(({ machine, proc, group }) => (
        <Row
          key={`${machine.id}:${proc.pid}`}
          swatch={GROUP_META[group].swatch}
          barPct={(proc.cpuPercent / max) * 100}
          barClass={GROUP_META[group].swatch}
          value={formatCpu(proc.cpuPercent)}
          testId="resources__top-row"
          attrs={{
            "data-kind": proc.kind,
            "data-pid": String(proc.pid),
            "data-machine": machine.id,
          }}
        >
          <ProcessLabel p={proc} onNavigate={onNavigate} />
          <Ctx>{machine.name}</Ctx>
        </Row>
      ))}
      <div className="px-3.5 py-2.5 text-xs text-muted-foreground">
        Percent of one core, so a busy process can pass 100%. A shell or agent includes the
        processes it started.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function StorageBody({
  machine,
  storage,
}: {
  machine: Machine;
  storage: { data?: StorageView; isLoading: boolean; isError: boolean; error: unknown } | undefined;
}) {
  const data = storage?.data;
  if (storage?.isError) {
    return (
      <div className="px-3.5 py-2.5 text-sm text-destructive" role="alert">
        Failed to measure: {String(storage.error)}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 px-3.5 py-2.5 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Measuring on {machine.name}…
      </div>
    );
  }
  const repos = new Map<string, { size: number; worktrees: StorageView["worktrees"] }>();
  for (const w of data.worktrees) {
    const entry = repos.get(w.repo) ?? { size: 0, worktrees: [] };
    entry.size += w.sizeBytes;
    entry.worktrees.push(w);
    repos.set(w.repo, entry);
  }
  const repoRows = [...repos.entries()].sort((a, b) => b[1].size - a[1].size);
  const worktreeTotal = repoRows.reduce((n, [, r]) => n + r.size, 0);
  const stateTotal = data.state.reduce((n, s) => n + s.sizeBytes, 0);
  const maxRepo = Math.max(1, ...repoRows.map(([, r]) => r.size));
  const maxState = Math.max(1, ...data.state.map((s) => s.sizeBytes));
  const low = data.disk ? data.disk.freeBytes / data.disk.totalBytes < 0.1 : false;
  return (
    <div data-testid={`resources__storage-${machine.id}`}>
      {data.disk && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2 text-xs text-muted-foreground">
          <span>
            Disk {data.disk.path} · {formatBytes(data.disk.totalBytes)}
          </span>
          <span
            className={`rounded-full border px-1.5 ${low ? "border-warning/50 text-warning" : "border-border"}`}
            data-testid={`resources__free-disk-${machine.id}`}
          >
            {formatBytes(data.disk.freeBytes)} free
          </span>
        </div>
      )}
      <details className="group border-b border-border" open>
        <summary className="grid cursor-pointer list-none grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-sm bg-chart-1" />
            <b className="font-semibold">Worktrees</b>
            <span className="text-xs text-muted-foreground">
              {data.worktrees.length} in {repoRows.length} repos · measured on {machine.name}
            </span>
          </span>
          <span
            className="text-right text-sm font-medium tabular-nums"
            data-testid="resources__group-total"
          >
            {formatBytes(worktreeTotal)}
          </span>
        </summary>
        {repoRows.length === 0 && (
          <div className="px-3.5 py-2 text-sm text-muted-foreground">
            No worktrees on this machine.
          </div>
        )}
        {repoRows.map(([repo, r]) => (
          <details
            key={repo}
            className="group/repo"
            data-testid={`resources__repo-${machine.id}-${repo}`}
          >
            <summary
              className="cursor-pointer list-none [&::-webkit-details-marker]:hidden"
              data-testid="resources__repo-toggle"
            >
              <Row
                swatch="bg-chart-1"
                barPct={(r.size / maxRepo) * 100}
                barClass="bg-chart-1"
                value={formatBytes(r.size)}
              >
                {repo}
                <Ctx>{r.worktrees.length} worktrees</Ctx>
              </Row>
            </summary>
            {[...r.worktrees]
              .sort((a, b) => b.sizeBytes - a.sizeBytes)
              .map((w) => (
                <Row
                  key={w.id}
                  value={w.error ? "error" : formatBytes(w.sizeBytes)}
                  testId="resources__worktree-size"
                  attrs={{ "data-worktree": w.id }}
                >
                  <span className="pl-4">{w.title ?? w.branch}</span>
                </Row>
              ))}
          </details>
        ))}
      </details>
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-sm bg-chart-2" />
            <b className="font-semibold">{machine.role === "hub" ? "Hub state" : "Worker state"}</b>
            <span className="text-xs text-muted-foreground">
              {machine.role === "hub"
                ? "database, checkpoints, sleep snapshots, runner logs, extensions"
                : "chats.db, terminal history, uploads, fenced snapshots"}
            </span>
          </span>
          <span className="text-right text-sm font-medium tabular-nums">
            {formatBytes(stateTotal)}
          </span>
        </summary>
        {data.state.map((s) => (
          <Row
            key={s.name}
            swatch="bg-chart-2"
            barPct={(s.sizeBytes / maxState) * 100}
            barClass="bg-chart-2"
            value={formatBytes(s.sizeBytes)}
          >
            <span className="font-mono text-xs">{s.name}</span>
          </Row>
        ))}
      </details>
    </div>
  );
}
