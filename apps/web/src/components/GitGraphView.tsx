import { useEffect, useMemo, useState } from "react";
import { trpc } from "../lib/trpc-client";

interface Commit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  ts: number;
  subject: string;
  refs: string[];
}

interface GraphRow {
  commit: Commit;
  lane: number;
  color: string;
  /** Lane occupants AFTER this commit is processed (drives outgoing edges). */
  outgoing: (string | null)[];
  /** Lane occupants BEFORE this commit (drives incoming pass-throughs). */
  incoming: (string | null)[];
}

const LANE_COLORS = [
  "#60a5fa", // blue-400
  "#4ade80", // green-400
  "#f87171", // red-400
  "#c084fc", // purple-400
  "#fb923c", // orange-400
  "#22d3ee", // cyan-400
  "#f472b6", // pink-400
  "#a3e635", // lime-400
  "#a78bfa", // violet-400
  "#2dd4bf", // teal-400
];

const LANE_WIDTH = 18;
const ROW_HEIGHT = 26;
const NODE_RADIUS = 5;
const GRAPH_PADDING_X = 12;
const STROKE_WIDTH = 2;

function colorForLane(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function buildGraph(commits: Commit[]): { rows: GraphRow[]; maxLanes: number } {
  const rows: GraphRow[] = [];
  const lanes: (string | null)[] = [];
  let maxLanes = 0;

  for (const commit of commits) {
    const incoming = lanes.slice();

    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(commit.sha);
      } else {
        lanes[lane] = commit.sha;
      }
    }

    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === commit.sha) {
        lanes[i] = null;
      }
    }

    const color = colorForLane(lane);

    const [firstParent, ...otherParents] = commit.parents;
    lanes[lane] = firstParent ?? null;

    for (const p of otherParents) {
      if (lanes.indexOf(p) !== -1) continue;
      let slot = lanes.indexOf(null);
      if (slot === -1) {
        slot = lanes.length;
        lanes.push(p);
      } else {
        lanes[slot] = p;
      }
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    const outgoing = lanes.slice();
    maxLanes = Math.max(maxLanes, incoming.length, outgoing.length, lane + 1);

    rows.push({ commit, lane, color, incoming, outgoing });
  }

  return { rows, maxLanes };
}

function laneX(lane: number): number {
  return GRAPH_PADDING_X + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function formatRelative(ts: number): string {
  const now = Date.now() / 1000;
  const delta = Math.max(0, now - ts);
  if (delta < 60) return `${Math.floor(delta)}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d`;
  if (delta < 86400 * 365) return `${Math.floor(delta / 86400 / 30)}mo`;
  return `${Math.floor(delta / 86400 / 365)}y`;
}

function authorInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function authorColor(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 55%, 45%)`;
}

interface RefBadge {
  label: string;
  kind: "head" | "branch" | "remote" | "tag" | "stash";
}

function classifyRef(raw: string): RefBadge | null {
  const ref = raw.trim();
  if (!ref) return null;
  if (ref.startsWith("HEAD -> ")) return { label: ref.slice(8), kind: "head" };
  if (ref === "HEAD") return { label: "HEAD", kind: "head" };
  if (ref.startsWith("tag: ")) return { label: ref.slice(5), kind: "tag" };
  if (ref.startsWith("refs/stash")) return { label: "stash", kind: "stash" };
  if (ref.includes("/")) return { label: ref, kind: "remote" };
  return { label: ref, kind: "branch" };
}

function refClasses(kind: RefBadge["kind"]): string {
  switch (kind) {
    case "head":
      return "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30";
    case "branch":
      return "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30";
    case "remote":
      return "bg-slate-500/15 text-slate-300 ring-1 ring-slate-500/30";
    case "tag":
      return "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30";
    case "stash":
      return "bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-500/30";
  }
}

interface GitGraphViewProps {
  workspaceId: string;
}

export function GitGraphView({ workspaceId }: GitGraphViewProps) {
  const [data, setData] = useState<{ commits: Commit[]; head: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hideStash, setHideStash] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey intentionally triggers refetch
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    trpc.workspace.getCommitGraph
      .query({ workspaceId, limit: 500 })
      .then((res) => {
        if (cancelled) return;
        setData({ commits: res.commits, head: res.head });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey]);

  const filteredCommits = useMemo(() => {
    if (!data) return null;
    if (!hideStash) return data.commits;
    return data.commits.filter(
      (c) => !c.refs.some((r) => r.startsWith("refs/stash")) && !c.subject.startsWith("WIP on "),
    );
  }, [data, hideStash]);

  const graph = useMemo(
    () => (filteredCommits ? buildGraph(filteredCommits) : null),
    [filteredCommits],
  );

  if (error) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar onRefresh={() => setRefreshKey((k) => k + 1)} />
        <div className="flex flex-1 items-center justify-center p-4 text-sm text-destructive">
          Failed to load git graph: {error}
        </div>
      </div>
    );
  }

  if (!graph) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar onRefresh={() => setRefreshKey((k) => k + 1)} />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      </div>
    );
  }

  if (graph.rows.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar onRefresh={() => setRefreshKey((k) => k + 1)} />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No commits.
        </div>
      </div>
    );
  }

  const graphWidth = GRAPH_PADDING_X * 2 + graph.maxLanes * LANE_WIDTH;
  const totalHeight = graph.rows.length * ROW_HEIGHT;

  return (
    <div className="flex h-full flex-col bg-background text-sm">
      <Toolbar
        onRefresh={() => setRefreshKey((k) => k + 1)}
        hideStash={hideStash}
        onToggleStash={() => setHideStash((v) => !v)}
        commitCount={graph.rows.length}
      />
      <div className="relative flex-1 overflow-auto">
        <div className="flex min-h-full" style={{ minWidth: "max-content" }}>
          <svg
            width={graphWidth}
            height={totalHeight}
            className="shrink-0"
            style={{ display: "block" }}
            role="img"
            aria-label="Commit graph"
          >
            <title>Commit graph</title>
            {(() => {
              const lines: React.ReactNode[] = [];
              const nodes: React.ReactNode[] = [];

              // Build per-lane continuous vertical segments. A segment is a
              // contiguous run of rows where the same lane index holds a non-null
              // sha. We render the run as a single line to avoid per-row cap
              // artifacts at row boundaries.
              type LaneRun = { lane: number; topY: number; botY: number };
              const runs: LaneRun[] = [];
              const open: Map<number, { topY: number }> = new Map();

              for (let i = 0; i < graph.rows.length; i++) {
                const row = graph.rows[i];
                const yTop = i * ROW_HEIGHT;
                const y = yTop + ROW_HEIGHT / 2;

                // Determine which lanes are "alive" through this row's vertical
                // axis. A lane is alive if either incoming[l] or outgoing[l] is
                // non-null. For the row containing this commit, the lane is also
                // alive at its centre (the node).
                const aliveLanes = new Set<number>();
                const maxLanes = Math.max(row.incoming.length, row.outgoing.length);
                for (let l = 0; l < maxLanes; l++) {
                  if (row.incoming[l] || row.outgoing[l]) aliveLanes.add(l);
                }
                aliveLanes.add(row.lane);

                // Close runs for lanes no longer alive. The run's botY clamps at
                // the previous row's bottom (i * ROW_HEIGHT) so it doesn't extend
                // into a row that doesn't carry it.
                for (const [l, run] of open) {
                  if (!aliveLanes.has(l)) {
                    runs.push({ lane: l, topY: run.topY, botY: i * ROW_HEIGHT });
                    open.delete(l);
                  }
                }

                // Open runs for newly-alive lanes. Start at this row's top.
                for (const l of aliveLanes) {
                  if (!open.has(l)) {
                    open.set(l, { topY: yTop });
                  }
                }

                // For rows where the commit's lane is BORN (incoming[lane] is
                // null AND it's a brand-new sha) the line should start at the
                // node centre instead of yTop. Detect: incoming has no entry for
                // this lane carrying this commit.
                const incomingHere = row.incoming[row.lane];
                if (
                  incomingHere !== row.commit.sha &&
                  open.has(row.lane) &&
                  open.get(row.lane)?.topY === yTop
                ) {
                  // Adjust start to node centre.
                  open.set(row.lane, { topY: y });
                }
              }

              // Flush remaining open runs to the bottom of the last row.
              const totalH = graph.rows.length * ROW_HEIGHT;
              for (const [l, run] of open) {
                runs.push({ lane: l, topY: run.topY, botY: totalH });
              }

              // For the LAST row of each lane (where the lane terminates because
              // its commit is at row.lane and outgoing has nothing for it), the
              // run already ends at i * ROW_HEIGHT (one row beyond), which is
              // correct. But terminating commits whose lane outgoing IS null
              // should end the line at the node centre, not at row bottom.
              // Walk runs and clip them where needed.
              const terminationY: Map<string, number> = new Map();
              for (let i = 0; i < graph.rows.length; i++) {
                const row = graph.rows[i];
                const yTop = i * ROW_HEIGHT;
                const y = yTop + ROW_HEIGHT / 2;
                const yBot = yTop + ROW_HEIGHT;
                if (!row.outgoing[row.lane]) {
                  // Lane dies after this commit — clip at node centre.
                  terminationY.set(`${row.lane}:${yBot}`, y);
                }
              }

              // Apply clip + emit.
              for (const r of runs) {
                const clipKey = `${r.lane}:${r.botY}`;
                const botY = terminationY.get(clipKey) ?? r.botY;
                if (botY <= r.topY) continue;
                lines.push(
                  <line
                    key={`run-${r.lane}-${r.topY}`}
                    x1={laneX(r.lane)}
                    y1={r.topY}
                    x2={laneX(r.lane)}
                    y2={botY}
                    stroke={colorForLane(r.lane)}
                    strokeWidth={STROKE_WIDTH}
                  />,
                );
              }

              // Emit diverging / converging bezier connectors per row.
              for (let i = 0; i < graph.rows.length; i++) {
                const row = graph.rows[i];
                const yTop = i * ROW_HEIGHT;
                const y = yTop + ROW_HEIGHT / 2;
                const yBot = yTop + ROW_HEIGHT;

                // Converging: incoming lane carries this commit but at a
                // different column. Curve from yTop@incomingLane to node.
                for (let l = 0; l < row.incoming.length; l++) {
                  if (l === row.lane) continue;
                  if (row.incoming[l] !== row.commit.sha) continue;
                  const x1 = laneX(l);
                  const x2 = laneX(row.lane);
                  lines.push(
                    <path
                      key={`cin-${row.commit.sha}-${l}`}
                      d={`M${x1},${yTop} C${x1},${yTop + ROW_HEIGHT * 0.45} ${x2},${y - ROW_HEIGHT * 0.45} ${x2},${y}`}
                      stroke={colorForLane(l)}
                      strokeWidth={STROKE_WIDTH}
                      fill="none"
                    />,
                  );
                }

                // Diverging: outgoing lane different from row.lane that carries
                // one of this commit's parents. Curve from node to yBot@outgoingLane.
                if (i < graph.rows.length - 1) {
                  for (let l = 0; l < row.outgoing.length; l++) {
                    if (l === row.lane) continue;
                    const sha = row.outgoing[l];
                    if (!sha || !row.commit.parents.includes(sha)) continue;
                    if (row.incoming[l] === sha) continue; // pass-through, not a new diverge
                    const x1 = laneX(row.lane);
                    const x2 = laneX(l);
                    lines.push(
                      <path
                        key={`cout-${row.commit.sha}-${l}`}
                        d={`M${x1},${y} C${x1},${y + ROW_HEIGHT * 0.45} ${x2},${yBot - ROW_HEIGHT * 0.45} ${x2},${yBot}`}
                        stroke={colorForLane(l)}
                        strokeWidth={STROKE_WIDTH}
                        fill="none"
                      />,
                    );
                  }
                }
              }

              for (let i = 0; i < graph.rows.length; i++) {
                const row = graph.rows[i];
                const y = i * ROW_HEIGHT + ROW_HEIGHT / 2;

                // Defer node into the top layer.
                const isHead = data?.head === row.commit.sha;
                nodes.push(
                  isHead ? (
                    <g key={`node-${row.commit.sha}`}>
                      <circle
                        cx={laneX(row.lane)}
                        cy={y}
                        r={NODE_RADIUS + 2}
                        fill="none"
                        stroke={row.color}
                        strokeWidth={2}
                      />
                      <circle cx={laneX(row.lane)} cy={y} r={NODE_RADIUS - 1} fill={row.color} />
                    </g>
                  ) : (
                    <circle
                      key={`node-${row.commit.sha}`}
                      cx={laneX(row.lane)}
                      cy={y}
                      r={NODE_RADIUS}
                      fill={row.color}
                    />
                  ),
                );
              }

              return (
                <>
                  <g>{lines}</g>
                  <g>{nodes}</g>
                </>
              );
            })()}
          </svg>

          <div
            className="border-l border-border/40"
            style={{ width: 0, marginLeft: 4 }}
            aria-hidden
          />

          <div className="min-w-0 flex-1">
            {graph.rows.map((row, i) => {
              const prev = i > 0 ? graph.rows[i - 1] : null;
              const sameAuthor = prev?.commit.email === row.commit.email;
              return (
                <CommitRow
                  key={row.commit.sha}
                  row={row}
                  isSelected={selected === row.commit.sha}
                  isHead={data?.head === row.commit.sha}
                  showAvatar={!sameAuthor}
                  onSelect={() => setSelected(row.commit.sha)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Toolbar({
  onRefresh,
  hideStash,
  onToggleStash,
  commitCount,
}: {
  onRefresh: () => void;
  hideStash?: boolean;
  onToggleStash?: () => void;
  commitCount?: number;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-3 py-1.5 text-xs">
      <button
        type="button"
        onClick={onRefresh}
        className="rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        Refresh
      </button>
      {onToggleStash && (
        <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={hideStash}
            onChange={onToggleStash}
            className="size-3.5 cursor-pointer"
          />
          Hide stash
        </label>
      )}
      <div className="flex-1" />
      {commitCount != null && (
        <span className="text-muted-foreground tabular-nums">{commitCount} commits</span>
      )}
    </div>
  );
}

function CommitRow({
  row,
  isSelected,
  isHead,
  showAvatar,
  onSelect,
}: {
  row: GraphRow;
  isSelected: boolean;
  isHead: boolean;
  showAvatar: boolean;
  onSelect: () => void;
}) {
  const badges = row.commit.refs.map(classifyRef).filter((b): b is RefBadge => b !== null);
  const visibleBadges = badges.slice(0, 3);
  const overflow = badges.length - visibleBadges.length;

  return (
    <button
      type="button"
      onClick={onSelect}
      title={row.commit.sha}
      style={{ height: ROW_HEIGHT }}
      className={`group flex w-full items-center gap-2 border-l-2 px-3 text-left transition-colors ${
        isSelected ? "border-l-foreground bg-accent" : "border-l-transparent hover:bg-accent/40"
      }`}
    >
      {showAvatar ? (
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{ backgroundColor: authorColor(row.commit.email) }}
          title={`${row.commit.author} <${row.commit.email}>`}
        >
          {authorInitials(row.commit.author)}
        </span>
      ) : (
        <span
          className="flex size-5 shrink-0 items-center justify-center"
          title={`${row.commit.author} <${row.commit.email}>`}
        >
          <span
            className="size-1.5 rounded-full opacity-50"
            style={{ backgroundColor: authorColor(row.commit.email) }}
          />
        </span>
      )}

      {visibleBadges.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {visibleBadges.map((b) => (
            <span
              key={`${b.kind}-${b.label}`}
              className={`inline-flex max-w-[140px] items-center truncate rounded px-1.5 py-0.5 text-[10px] font-medium ${refClasses(b.kind)}`}
            >
              {b.label}
            </span>
          ))}
          {overflow > 0 && <span className="text-[10px] text-muted-foreground">+{overflow}</span>}
        </span>
      )}

      <span className={`min-w-0 flex-1 truncate ${isHead ? "font-medium" : ""}`}>
        {row.commit.subject}
      </span>

      <span className="hidden shrink-0 truncate text-xs text-muted-foreground md:inline md:max-w-[140px]">
        {row.commit.author}
      </span>

      <span className="shrink-0 font-mono text-xs text-muted-foreground/80">
        {row.commit.sha.slice(0, 7)}
      </span>

      <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {formatRelative(row.commit.ts)}
      </span>
    </button>
  );
}
