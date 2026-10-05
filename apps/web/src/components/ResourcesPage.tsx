import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ScrollArea,
  Spinner,
} from "@band-app/ui";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import { trpc } from "../lib/trpc-client";

interface ServerSnapshot {
  pid: number;
  uptimeSeconds: number;
  nodeVersion: string;
  platform: string;
  arch: string;
  memory: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  cpu: {
    userMicros: number;
    systemMicros: number;
  };
}

// Mirrors the mapper output in
// apps/desktop/src/main/ipc/app-metrics.ts. Defined inline (not imported)
// so the web app never gains a build-time dependency on desktop types —
// same pattern as `ServerSnapshot` above.
interface AppProcessMetric {
  pid: number;
  label: string;
  type: string;
  cpuPercent: number;
  memoryKB: number;
}

interface AppMetrics {
  processCount: number;
  totalMemoryKB: number;
  totalCpuPercent: number;
  processes: AppProcessMetric[];
}

interface RepoListing {
  repo: string;
  path: string;
  worktrees: Array<{ branch: string; path: string }>;
  error?: string;
}

interface ReposResponse {
  repos: RepoListing[];
}

interface WorktreeSize {
  branch: string;
  path: string;
  sizeBytes: number;
  error?: string;
}

interface RepoSize {
  repo: string;
  sizeBytes: number;
  worktrees: WorktreeSize[];
  error?: string;
}

const BYTES_PER_MB = 1024 * 1024;

function formatMB(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < BYTES_PER_MB * 1024) return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
  return `${(bytes / (BYTES_PER_MB * 1024)).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor((seconds / 3600) % 24);
  const d = Math.floor(seconds / 86400);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function formatCpuMs(micros: number): string {
  const ms = micros / 1000;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Make a repo + branch pair safe to embed in a `data-testid`.
 * Git allows `/`, `.`, and other chars that are legal in an
 * attribute value but awkward to grep, and the two halves need to
 * be combined uniquely — two repos with a `main` branch would
 * otherwise collide on `resources-worktree-row-main` and break
 * Playwright strict-mode locators. Replace anything outside
 * `[A-Za-z0-9_-]` with `_`, then join with `__`.
 */
function testIdForWorktree(repo: string, branch: string): string {
  const safe = (s: string) => s.replace(/[^\w-]/g, "_");
  return `${safe(repo)}__${safe(branch)}`;
}

/**
 * Bound on simultaneous in-flight per-repo `du` requests. The
 * server walks each request as `Promise.all` over that repo's
 * worktrees (one `du -sk` process per worktree), so this is the
 * client-side "how many repos should we be measuring at once"
 * — not the total `du` process count. 3 keeps the spinner pattern
 * visibly progressive on a 5-10 repo setup, doesn't bury a
 * shared SSD in random reads, and means a slow repo can't
 * starve the whole queue.
 */
const REPO_FETCH_CONCURRENCY = 3;

/**
 * Run `fn` over every item with at most `limit` running at once.
 * Returns when all items have been processed (or `cancelled` flips
 * true, in which case still-pending iterations are skipped).
 *
 * Inline worker-pool — pulling in `p-limit` for ~20 lines would
 * be overkill, and React Query doesn't offer this primitive out
 * of the box (its `useQueries` would fire everything at once).
 */
async function runWithLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  isCancelled: () => boolean,
): Promise<void> {
  let nextIdx = 0;
  async function worker() {
    while (true) {
      if (isCancelled()) return;
      const idx = nextIdx++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

export function ResourcesPage() {
  const serverQuery = useQuery<ServerSnapshot>({
    queryKey: ["resources", "server"],
    queryFn: () => trpc.services.resourcesServer.query(),
  });

  // Electron/Chromium process metrics — desktop shell only. The web app
  // never launches Electron, so this stays disabled (and the card below
  // returns null) outside the desktop shell.
  const appMetricsQuery = useQuery<AppMetrics>({
    queryKey: ["resources", "app-metrics"],
    queryFn: () => invoke<AppMetrics>("get_app_metrics"),
    enabled: isDesktop,
  });

  // Cheap query — just `git worktree list --porcelain` per repo,
  // no disk walks. Fires on mount automatically.
  const reposQuery = useQuery<ReposResponse>({
    queryKey: ["resources", "repos"],
    queryFn: () => trpc.services.resourcesRepos.query(),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Per-repo disk-usage cache, populated as `du` calls finish.
  // Key absent = not yet measured (show spinner). Cleared on
  // Refresh + on initial mount of a fresh repo list.
  const [sizes, setSizes] = useState<Map<string, RepoSize>>(() => new Map());
  // Bumped by the Refresh button to force the size-fetch effect to
  // re-run even if the underlying repos list hasn't changed.
  const [refreshKey, setRefreshKey] = useState(0);

  const server = serverQuery.data;
  const repos = reposQuery.data?.repos ?? [];

  // Stable identity for the repos list — keyed only on repo
  // names, not the array reference. Without this, every render
  // before the query resolves hands `useEffect` a fresh `[]`
  // literal, and any future refetch (window focus, manual
  // `invalidateQueries`, …) flaps the cache by re-issuing the
  // whole `setSizes(new Map())` + queue dispatch. The `useMemo`
  // freezes the list while the underlying repo set is stable.
  //
  // `repos` is intentionally NOT in the dep list — the join'd
  // names string is the stable identity we're keying on. Biome's
  // exhaustive-deps rule reads that as a missing dep; suppressing
  // is the correct call.
  const repoNames = repos.map((p) => p.repo).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoNames is the intentional stable-identity key
  const reposRef = useMemo(() => repos, [repoNames]);

  // Kick off per-repo size fetches in a concurrency-limited loop
  // whenever the repos set actually changes or the user hits
  // Refresh. `cancelled` guards against state writes after the
  // dialog unmounts or another refresh fires mid-flight.
  //
  // `refreshKey` is a deliberate re-run trigger (no body read), so
  // biome's exhaustive-deps rule flags it as "extra" — but forcing
  // the re-run is the entire point on Refresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the re-run trigger
  useEffect(() => {
    if (reposRef.length === 0) return;
    let cancelled = false;
    setSizes(new Map());

    void runWithLimit(
      reposRef,
      REPO_FETCH_CONCURRENCY,
      async (p) => {
        try {
          const data = await trpc.services.resourcesRepoSize.query({ repo: p.repo });
          if (cancelled) return;
          setSizes((prev) => {
            const next = new Map(prev);
            next.set(p.repo, data);
            return next;
          });
        } catch (err) {
          if (cancelled) return;
          setSizes((prev) => {
            const next = new Map(prev);
            next.set(p.repo, {
              repo: p.repo,
              sizeBytes: 0,
              worktrees: [],
              error: err instanceof Error ? err.message : String(err),
            });
            return next;
          });
        }
      },
      () => cancelled,
    );

    return () => {
      cancelled = true;
    };
  }, [reposRef, refreshKey]);

  const handleRefreshSizes = useCallback(async () => {
    await reposQuery.refetch();
    setRefreshKey((k) => k + 1);
  }, [reposQuery]);

  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(() => new Set());
  const toggleRepo = (repo: string) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  };

  // Sorted view of the repos list — known sizes first (largest
  // to smallest by `sizeBytes`), then everything still loading in
  // its incoming order so the spinners don't reshuffle as data
  // arrives. Note: a repo whose `du` walk errored is recorded
  // with `sizeBytes: 0`, which sorts identically to a real
  // zero-byte repo; both end up at the bottom of the
  // size-known group. We treat that as acceptable because errors
  // are also surfaced inline (the size cell renders "error").
  const sortedRepos = useMemo(
    () =>
      [...repos].sort((a, b) => {
        const sa = sizes.get(a.repo);
        const sb = sizes.get(b.repo);
        if (sa && sb) return sb.sizeBytes - sa.sizeBytes;
        if (sa && !sb) return -1;
        if (!sa && sb) return 1;
        return 0;
      }),
    [repos, sizes],
  );

  const knownTotalBytes = useMemo(
    () => Array.from(sizes.values()).reduce((sum, s) => sum + s.sizeBytes, 0),
    [sizes],
  );
  // Total worktree count across all repos — shown in the table footer.
  const totalWorktreeCount = useMemo(
    () => repos.reduce((sum, p) => sum + p.worktrees.length, 0),
    [repos],
  );
  // "All sizes accounted for" — true when every repo has either
  // a known size or there are no repos at all. The latter case
  // matters because the user with zero tracked repos would
  // otherwise see a perpetually-spinning Refresh button (sizes.size
  // === 0 === repos.length, but the previous `> 0` guard
  // excluded that path).
  const allLoaded = sizes.size === repos.length;

  // Each card starts collapsed (issue: compact overview by default) —
  // its headline total shows next to the title until the user expands
  // it. Per-panel state so opening one doesn't touch the others.
  const [serverOpen, setServerOpen] = useState(false);
  const [worktreesOpen, setWorktreesOpen] = useState(false);

  return (
    <ScrollArea className="h-full w-full">
      <div className="mx-auto max-w-5xl px-6 py-4">
        {/* One settings-style section: a single rounded border wrapping
            every panel, with 1px dividers auto-inserted between them
            (`[&>*+*]:border-t`). Panels carry no border of their own. */}
        <div className="overflow-hidden rounded-xl border border-border [&>*+*]:border-t [&>*+*]:border-border">
          <Collapsible open={serverOpen} onOpenChange={setServerOpen} asChild>
            <section data-testid="resources-server-card">
              <PanelHeader
                title="Server"
                toggleTestId="resources-server-toggle"
                open={serverOpen}
                totalTestId="resources-server-total"
                total={server ? formatMB(server.memory.rssBytes) : "…"}
                description={`The Node process serving the Band dashboard (${
                  server ? `pid ${server.pid}` : "…"
                }).`}
                refresh={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Refresh"
                    title="Refresh"
                    data-testid="resources-refresh-server"
                    onClick={() => serverQuery.refetch()}
                    disabled={serverQuery.isFetching}
                  >
                    {serverQuery.isFetching ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                  </Button>
                }
              />
              <CollapsibleContent>
                <div className="border-t border-border p-4">
                  {serverQuery.isError ? (
                    <p className="text-sm text-destructive">
                      Failed to load server snapshot: {String(serverQuery.error)}
                    </p>
                  ) : !server ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Spinner className="size-4" />
                      Loading…
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
                      <ServerField label="PID">
                        <span data-testid="resources-server-pid">{server.pid}</span>
                      </ServerField>
                      <ServerField label="Uptime">{formatUptime(server.uptimeSeconds)}</ServerField>
                      <ServerField label="Node">{server.nodeVersion}</ServerField>
                      <ServerField label="Platform">
                        {server.platform} ({server.arch})
                      </ServerField>
                      <ServerField label="RSS">{formatMB(server.memory.rssBytes)}</ServerField>
                      <ServerField label="Heap used">
                        {formatMB(server.memory.heapUsedBytes)}
                      </ServerField>
                      <ServerField label="Heap total">
                        {formatMB(server.memory.heapTotalBytes)}
                      </ServerField>
                      <ServerField label="External">
                        {formatMB(server.memory.externalBytes)}
                      </ServerField>
                      <ServerField label="Array buffers">
                        {formatMB(server.memory.arrayBuffersBytes)}
                      </ServerField>
                      <ServerField label="Total CPU time (user)">
                        {formatCpuMs(server.cpu.userMicros)}
                      </ServerField>
                      <ServerField label="Total CPU time (system)">
                        {formatCpuMs(server.cpu.systemMicros)}
                      </ServerField>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </section>
          </Collapsible>

          <ElectronCard query={appMetricsQuery} />

          <Collapsible open={worktreesOpen} onOpenChange={setWorktreesOpen} asChild>
            <section data-testid="resources-worktrees-card">
              <PanelHeader
                title="Worktrees"
                toggleTestId="resources-worktrees-toggle"
                open={worktreesOpen}
                totalTestId="resources-worktrees-total"
                total={`${formatBytes(knownTotalBytes)}${allLoaded ? "" : " (partial)"}`}
                description={
                  <>
                    Disk usage per tracked git repo (allocated blocks, as reported by{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs">du</code>). Sizes load
                    per repo in batches of {REPO_FETCH_CONCURRENCY}. Click a repo to see its
                    per-worktree breakdown.
                  </>
                }
                refresh={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Refresh"
                    title="Refresh"
                    data-testid="resources-refresh-worktrees"
                    onClick={handleRefreshSizes}
                    disabled={reposQuery.isFetching || !allLoaded}
                  >
                    {reposQuery.isFetching || !allLoaded ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                  </Button>
                }
              />
              <CollapsibleContent>
                <div className="border-t border-border p-4">
                  {reposQuery.isError ? (
                    <p className="text-sm text-destructive">
                      Failed to load repos: {String(reposQuery.error)}
                    </p>
                  ) : (
                    <div className="relative overflow-x-auto">
                      <table
                        data-testid="resources-repos-table"
                        className="w-full border-collapse text-sm"
                      >
                        <thead>
                          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            <th className="py-2 pr-3">Repo</th>
                            <th className="py-2 pr-3 text-right">Worktrees</th>
                            <th className="py-2 pr-3 text-right">Total size</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedRepos.length === 0 ? (
                            <tr>
                              <td
                                colSpan={3}
                                className="py-6 text-center text-sm text-muted-foreground"
                              >
                                {reposQuery.isFetching ? "Loading…" : "No git repos found"}
                              </td>
                            </tr>
                          ) : (
                            sortedRepos.map((repo) => {
                              const size = sizes.get(repo.repo);
                              const isExpanded = expandedRepos.has(repo.repo);
                              return (
                                <Fragment key={repo.repo}>
                                  {/* See the cell-scoped <button> below — a
                              row-level click handler can't be a
                              real <button> (must be a direct
                              <tbody> child), so we put the button
                              in the first cell and let it span the
                              click target. */}
                                  <tr
                                    data-testid={`resources-repo-row-${repo.repo}`}
                                    data-expanded={isExpanded ? "true" : "false"}
                                    className="border-b border-border/60 last:border-0 hover:bg-muted/40"
                                  >
                                    <td className="py-2 pr-3 font-medium">
                                      <button
                                        type="button"
                                        aria-expanded={isExpanded}
                                        onClick={() => toggleRepo(repo.repo)}
                                        className="inline-flex w-full cursor-pointer items-center gap-1 text-left"
                                      >
                                        <ChevronRight
                                          className={`size-3.5 shrink-0 transition-transform ${
                                            isExpanded ? "rotate-90" : ""
                                          }`}
                                        />
                                        {repo.repo}
                                      </button>
                                    </td>
                                    <td className="py-2 pr-3 text-right tabular-nums">
                                      {repo.worktrees.length}
                                    </td>
                                    <td
                                      className="py-2 pr-3 text-right tabular-nums"
                                      data-testid={`resources-repo-size-${repo.repo}`}
                                    >
                                      {size === undefined ? (
                                        <span className="inline-flex items-center justify-end gap-1.5 text-muted-foreground">
                                          <Spinner className="size-3.5" />
                                          <span className="text-xs">measuring…</span>
                                        </span>
                                      ) : size.error ? (
                                        <span className="text-destructive" title={size.error}>
                                          error
                                        </span>
                                      ) : (
                                        formatBytes(size.sizeBytes)
                                      )}
                                    </td>
                                  </tr>
                                  {isExpanded &&
                                    (size === undefined ? (
                                      // Sizes haven't landed yet — show one
                                      // child row with a spinner so the
                                      // expand isn't an empty void.
                                      <tr className="border-b border-border/40 bg-muted/20">
                                        <td colSpan={3} className="py-2 pl-8 pr-3">
                                          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                                            <Spinner className="size-3.5" />
                                            Measuring worktrees…
                                          </span>
                                        </td>
                                      </tr>
                                    ) : size.worktrees.length === 0 ? (
                                      <tr className="border-b border-border/40 bg-muted/20">
                                        <td
                                          colSpan={3}
                                          className="py-2 pl-8 pr-3 text-xs text-muted-foreground"
                                        >
                                          No worktrees
                                        </td>
                                      </tr>
                                    ) : (
                                      size.worktrees.map((wt) => (
                                        <tr
                                          key={`${repo.repo}::${wt.branch}::${wt.path}`}
                                          data-testid={`resources-worktree-row-${testIdForWorktree(repo.repo, wt.branch)}`}
                                          className="border-b border-border/40 bg-muted/20 last:border-0"
                                        >
                                          <td className="py-1.5 pl-8 pr-3">
                                            <div className="flex flex-col">
                                              <span className="font-mono text-xs">
                                                {wt.branch || "—"}
                                              </span>
                                              <span className="truncate font-mono text-[11px] text-muted-foreground">
                                                {wt.path}
                                              </span>
                                            </div>
                                          </td>
                                          <td className="py-1.5 pr-3" />
                                          <td className="py-1.5 pr-3 text-right tabular-nums">
                                            {wt.error ? (
                                              <span className="text-destructive">error</span>
                                            ) : (
                                              formatBytes(wt.sizeBytes)
                                            )}
                                          </td>
                                        </tr>
                                      ))
                                    ))}
                                </Fragment>
                              );
                            })
                          )}
                        </tbody>
                        {repos.length > 0 && (
                          <tfoot>
                            <tr className="border-t-2 border-border font-medium">
                              <td className="py-2 pr-3">Total{allLoaded ? "" : " (partial)"}</td>
                              <td className="py-2 pr-3 text-right tabular-nums">
                                {totalWorktreeCount}
                              </td>
                              <td
                                className="py-2 pr-3 text-right tabular-nums"
                                data-testid="resources-repos-total"
                              >
                                {formatBytes(knownTotalBytes)}
                              </td>
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </section>
          </Collapsible>
        </div>
      </div>
    </ScrollArea>
  );
}

/**
 * "Desktop app (Electron)" card — a per-process breakdown of the Electron
 * main process, GPU process, Chromium renderers (dashboard + browser tabs),
 * and Utility helpers, via `app.getAppMetrics()`.
 *
 * Self-gating: renders nothing outside the Electron shell (the web-server
 * build has no `get_app_metrics` handler and no Electron processes to
 * report), so the whole card is desktop-only.
 */
function ElectronCard({ query }: { query: UseQueryResult<AppMetrics> }) {
  const [open, setOpen] = useState(false);

  if (!isDesktop) return null;

  const metrics = query.data;

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section data-testid="resources-electron-card">
        <PanelHeader
          title="Desktop app (Electron)"
          toggleTestId="resources-electron-toggle"
          open={open}
          totalTestId="resources-electron-total"
          total={metrics ? formatBytes(metrics.totalMemoryKB * 1024) : "…"}
          description="Per-process CPU and memory for the Electron main process, GPU process, Chromium renderers (the dashboard and each browser tab), and utility helpers."
          refresh={
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Refresh"
              title="Refresh"
              data-testid="resources-refresh-electron"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching ? (
                <Spinner className="size-3.5" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          }
        />
        <CollapsibleContent>
          <div className="border-t border-border p-4">
            {query.isError ? (
              <p className="text-sm text-destructive">
                Failed to load Electron metrics: {String(query.error)}
              </p>
            ) : !metrics ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                Loading…
              </div>
            ) : (
              <div className="relative overflow-x-auto">
                <table
                  data-testid="resources-electron-table"
                  className="w-full border-collapse text-sm"
                >
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3">Process</th>
                      <th className="py-2 pr-3">Type</th>
                      <th className="py-2 pr-3 text-right">PID</th>
                      <th className="py-2 pr-3 text-right">CPU</th>
                      <th className="py-2 pr-3 text-right">Memory</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.processes.map((p) => (
                      <tr
                        key={p.pid}
                        data-testid={`resources-electron-row-${p.pid}`}
                        className="border-b border-border/60 last:border-0 hover:bg-muted/40"
                      >
                        <td className="py-1.5 pr-3">{p.label}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{p.type}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{p.pid}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {p.cpuPercent.toFixed(1)}%
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {formatBytes(p.memoryKB * 1024)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border font-medium">
                      <td className="py-2 pr-3" data-testid="resources-electron-total-count">
                        Total ({metrics.processCount})
                      </td>
                      <td className="py-2 pr-3" />
                      <td className="py-2 pr-3" />
                      <td
                        className="py-2 pr-3 text-right tabular-nums"
                        data-testid="resources-electron-total-cpu"
                      >
                        {metrics.totalCpuPercent.toFixed(1)}%
                      </td>
                      <td
                        className="py-2 pr-3 text-right tabular-nums"
                        data-testid="resources-electron-total-memory"
                      >
                        {formatBytes(metrics.totalMemoryKB * 1024)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/**
 * Shared card header for the collapsible Resources panels: a chevron +
 * title trigger (the whole title row toggles the panel), the panel's
 * headline `total` shown to the right of the title only while collapsed,
 * the `description` shown in both states, and a `refresh` control kept
 * as a sibling of the trigger (never nested — Radix's trigger is a
 * `<button>`, and buttons can't nest).
 */
function PanelHeader({
  title,
  toggleTestId,
  open,
  total,
  totalTestId,
  description,
  refresh,
}: {
  title: string;
  toggleTestId: string;
  open: boolean;
  total: string;
  totalTestId: string;
  description: React.ReactNode;
  refresh: React.ReactNode;
}) {
  return (
    <div className="flex flex-row items-start justify-between gap-2 p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="text-base font-semibold leading-none">
          <CollapsibleTrigger
            data-testid={toggleTestId}
            className="group flex w-full items-center gap-2 text-left"
          >
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            <span>{title}</span>
            {!open && (
              <span
                data-testid={totalTestId}
                className="ml-auto pl-2 font-mono text-sm font-normal text-muted-foreground"
              >
                {total}
              </span>
            )}
          </CollapsibleTrigger>
        </h2>
        <p className="pl-6 text-sm text-muted-foreground">{description}</p>
      </div>
      {refresh}
    </div>
  );
}

function ServerField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-sm">{children}</span>
    </div>
  );
}
