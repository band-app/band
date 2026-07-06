import { useEffect, useMemo, useState } from "react";
import { trpc } from "../lib/trpc-client";
import { CommitDetailsPanel } from "./GitCommitDetails";

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

// Git records a stash as up to three commits: the stash tip
// ("WIP on <branch>: …" or "On <branch>: …"), an index snapshot
// ("index on <branch>: …"), and — with `-u` — a parentless untracked-files
// root ("untracked files on <branch>: …"). The index/untracked pair are pure
// bookkeeping: like Fork/GitKraken we never surface them as their own nodes
// (they'd render as extra dangling lanes). The tip is shown as a single node
// unless "Hide stash" is on.
const STASH_INTERNAL_SUBJECT = /^(?:index on|untracked files on) \S+: /;
const STASH_TIP_SUBJECT = /^(?:WIP on|On) \S+: /;

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
    // The first parent inherits this commit's lane, so a first-parent chain
    // (e.g. the develop/main spine) stays in one stable column top-to-bottom.
    // If the first parent was ALSO reserved by another lane (a branch based on
    // it), that duplicate is intentional: when the parent is finally processed
    // it takes the lowest reserved lane and the higher one converges into it
    // (the dedup pass above), rendering the branch as an excursion that merges
    // back — instead of the spine hopping columns.
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
  // Soft pastel fills with a clear ring so refs read at a glance in both
  // themes: darker text on light backgrounds, light-pastel text on dark.
  switch (kind) {
    case "head":
      return "bg-emerald-400/25 text-emerald-800 ring-1 ring-emerald-500/40 dark:text-emerald-200 dark:ring-emerald-400/40";
    case "branch":
      return "bg-sky-400/25 text-sky-800 ring-1 ring-sky-500/40 dark:text-sky-200 dark:ring-sky-400/40";
    case "remote":
      return "bg-indigo-400/25 text-indigo-800 ring-1 ring-indigo-500/40 dark:text-indigo-200 dark:ring-indigo-400/40";
    case "tag":
      return "bg-amber-400/30 text-amber-900 ring-1 ring-amber-500/50 dark:text-amber-200 dark:ring-amber-400/40";
    case "stash":
      return "bg-fuchsia-400/25 text-fuchsia-800 ring-1 ring-fuchsia-500/40 dark:text-fuchsia-200 dark:ring-fuchsia-400/40";
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
    const kept = data.commits.filter((c) => {
      // Index/untracked bookkeeping commits are never shown.
      if (STASH_INTERNAL_SUBJECT.test(c.subject)) return false;
      // The stash tip is shown as a single node unless "Hide stash" is on.
      if (
        hideStash &&
        (c.refs.some((r) => r.startsWith("refs/stash")) || STASH_TIP_SUBJECT.test(c.subject))
      ) {
        return false;
      }
      return true;
    });
    // Prune parent links that point at a dropped commit (e.g. a shown stash
    // tip's index/untracked parents) so no lane dangles toward a hidden node.
    const present = new Set(kept.map((c) => c.sha));
    return kept.map((c) => ({
      ...c,
      parents: c.parents.filter((p) => present.has(p)),
    }));
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

              // Draw edges as two half-segments per row so every lane occupant
              // connects cleanly to the node at its centre with no gaps: the
              // top half joins incoming lanes down to the node (or their
              // straight continuation), the bottom half joins the node down to
              // each parent's lane, plus any straight pass-through lanes.
              // Adjacent rows' half-segments share endpoints, so continuous
              // lanes render as unbroken vertical lines.
              const seg = (
                x1: number,
                y1: number,
                x2: number,
                y2: number,
                color: string,
                key: string,
              ) => {
                lines.push(
                  <line
                    key={key}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={color}
                    strokeWidth={STROKE_WIDTH}
                  />,
                );
              };
              const curve = (
                x1: number,
                y1: number,
                x2: number,
                y2: number,
                color: string,
                key: string,
              ) => {
                const my = (y1 + y2) / 2;
                lines.push(
                  <path
                    key={key}
                    d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`}
                    stroke={color}
                    strokeWidth={STROKE_WIDTH}
                    fill="none"
                  />,
                );
              };

              for (let i = 0; i < graph.rows.length; i++) {
                const row = graph.rows[i];
                const yTop = i * ROW_HEIGHT;
                const y = yTop + ROW_HEIGHT / 2;
                const yBot = yTop + ROW_HEIGHT;
                const lane = row.lane;
                const nodeX = laneX(lane);
                const sha = row.commit.sha;

                // Top half: every incoming lane occupant reaches the node (when
                // it's awaiting this commit) or continues straight to the centre.
                for (let l = 0; l < row.incoming.length; l++) {
                  const occ = row.incoming[l];
                  if (!occ) continue;
                  const x = laneX(l);
                  if (occ === sha) {
                    if (l === lane) {
                      seg(x, yTop, nodeX, y, colorForLane(lane), `t-${sha}-${l}`);
                    } else {
                      curve(x, yTop, nodeX, y, colorForLane(l), `tc-${sha}-${l}`);
                    }
                  } else {
                    seg(x, yTop, x, y, colorForLane(l), `tp-${sha}-${l}`);
                  }
                }

                // Bottom half: lane-driven so every outgoing lane gets a
                // segment (no gaps). Each non-null outgoing lane is one of:
                //   - the node's own lane        → straight node → yBot
                //   - unchanged from incoming     → straight pass-through
                //   - freshly placed this row     → curve out from the node
                //     (a parent fanning into a new lane)
                // Driving off the lane occupancy (rather than
                // `outgoing.indexOf(parent)`, which returns only the first of a
                // duplicated sha) is what keeps the node's own lane connected
                // when its first parent already occupies a lower lane.
                for (let l = 0; l < row.outgoing.length; l++) {
                  const occ = row.outgoing[l];
                  if (!occ) continue;
                  const x = laneX(l);
                  if (l === lane) {
                    seg(nodeX, y, x, yBot, colorForLane(lane), `b-${sha}-${l}`);
                  } else if (row.incoming[l] === occ) {
                    seg(x, y, x, yBot, colorForLane(l), `bp-${sha}-${l}`);
                  } else {
                    curve(nodeX, y, x, yBot, colorForLane(l), `bd-${sha}-${l}`);
                  }
                }

                // Merge joins: a parent that already occupied its own lane
                // (a pass-through above) still needs a connector from the merge
                // node into that lane, drawn on top of the straight line.
                for (const parent of row.commit.parents) {
                  const l = row.outgoing.indexOf(parent);
                  if (l === -1 || l === lane) continue;
                  if (row.incoming[l] === parent) {
                    curve(nodeX, y, laneX(l), yBot, colorForLane(l), `bm-${sha}-${l}`);
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
      {selected && (
        <CommitDetailsPanel
          workspaceId={workspaceId}
          sha={selected}
          onClose={() => setSelected(null)}
        />
      )}
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
            data-testid="git-graph__hide-stash"
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
              className={`inline-flex max-w-[140px] items-center truncate rounded px-1.5 py-0.5 text-[10px] font-semibold ${refClasses(b.kind)}`}
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
