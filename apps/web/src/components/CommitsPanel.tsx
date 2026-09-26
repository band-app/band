import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileStatus } from "@/dashboard";
import { FileStatusBadge } from "../dashboard/components/FileStatusBadge";
import { getFileIcon } from "../dashboard/lib/file-icon";
import {
  buildGraphRows,
  commitLaneIndex,
  GRAPH_REF_COLOR,
  type GraphLane,
  type GraphRow,
  mergeParentLaneIndex,
} from "../lib/git-history-graph";
import { trpc } from "../lib/trpc-client";

// The Commits section at the bottom of the Changes tab: the workspace's
// HEAD history as a swimlane graph (after Orca's source-control sidebar),
// with ref pills, and commits that expand to their changed files. A file
// click opens that file's diff for the commit in the center dockview.

type HistoryPage = Awaited<ReturnType<typeof trpc.workspace.getCommitHistory.query>>;
type HistoryCommit = HistoryPage["commits"][number];
type CommitRef = HistoryCommit["refs"][number];

const PAGE_SIZE = 50;
// HEAD / refs are checked this often while the panel is open; the history
// itself is only reloaded when that signature moves.
const SIGNATURE_POLL_MS = 5_000;

const COLLAPSED_KEY = "band:commits-panel-collapsed";
const HEIGHT_KEY = "band:commits-panel-height";
const DEFAULT_HEIGHT = 256;
const MIN_HEIGHT = 96;
const MAX_HEIGHT = 640;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function clampHeight(h: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(h)));
}

// ---------------------------------------------------------------------------
// Graph slice for one row
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 24;
const LANE_WIDTH = 11;
const CURVE_RADIUS = 5;
const NODE_Y = ROW_HEIGHT / 2;
const NODE_RADIUS = 3.5;

function GraphPath({ d, color }: { d: string; color: string }) {
  return <path d={d} fill="none" stroke={color} strokeLinecap="round" strokeWidth={1} />;
}

/** One row's slice of the graph: lanes passing through, lanes shifting
 *  left, merge curves, and the commit's dot. Ported from Orca's
 *  `git-history-graph-svg.tsx`. */
function CommitGraphSlice({ row }: { row: GraphRow<HistoryCommit> }) {
  const { commit, inputSwimlanes, outputSwimlanes } = row;
  const inputIndex = inputSwimlanes.findIndex((n) => n.id === commit.sha);
  const circleIndex = commitLaneIndex(row);
  const circleColor =
    outputSwimlanes[circleIndex]?.color ?? inputSwimlanes[circleIndex]?.color ?? GRAPH_REF_COLOR;

  const paths: React.JSX.Element[] = [];
  let outIndex = 0;

  for (let index = 0; index < inputSwimlanes.length; index++) {
    const lane = inputSwimlanes[index];
    if (lane.id === commit.sha) {
      if (index !== circleIndex) {
        // A second lane converging into this commit bends into its dot.
        paths.push(
          <GraphPath
            key={`base-${index}`}
            color={lane.color}
            d={`M ${LANE_WIDTH * (index + 1)} 0 A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${LANE_WIDTH * index} ${NODE_Y} H ${LANE_WIDTH * (circleIndex + 1)}`}
          />,
        );
      } else {
        outIndex++;
      }
      continue;
    }
    if (outIndex < outputSwimlanes.length && lane.id === outputSwimlanes[outIndex].id) {
      if (index === outIndex) {
        paths.push(
          <GraphPath
            key={`v-${index}`}
            color={lane.color}
            d={`M ${LANE_WIDTH * (index + 1)} 0 V ${ROW_HEIGHT}`}
          />,
        );
      } else {
        // The lane moves left to fill a gap a finished lane left behind.
        paths.push(
          <GraphPath
            key={`shift-${index}`}
            color={lane.color}
            d={[
              `M ${LANE_WIDTH * (index + 1)} 0`,
              "V 6",
              `A ${CURVE_RADIUS} ${CURVE_RADIUS} 0 0 1 ${LANE_WIDTH * (index + 1) - CURVE_RADIUS} ${NODE_Y}`,
              `H ${LANE_WIDTH * (outIndex + 1) + CURVE_RADIUS}`,
              `A ${CURVE_RADIUS} ${CURVE_RADIUS} 0 0 0 ${LANE_WIDTH * (outIndex + 1)} ${NODE_Y + CURVE_RADIUS}`,
              `V ${ROW_HEIGHT}`,
            ].join(" ")}
          />,
        );
      }
      outIndex++;
    }
  }

  for (let i = 1; i < commit.parents.length; i++) {
    const parentLane = mergeParentLaneIndex(row, commit.parents[i]);
    if (parentLane === -1) continue;
    paths.push(
      <GraphPath
        key={`merge-${i}`}
        color={outputSwimlanes[parentLane].color}
        d={`M ${LANE_WIDTH * parentLane} ${NODE_Y} A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${LANE_WIDTH * (parentLane + 1)} ${ROW_HEIGHT} M ${LANE_WIDTH * parentLane} ${NODE_Y} H ${LANE_WIDTH * (circleIndex + 1)}`}
      />,
    );
  }

  const cx = LANE_WIDTH * (circleIndex + 1);
  if (inputIndex !== -1) {
    paths.push(
      <GraphPath key="in" color={inputSwimlanes[inputIndex].color} d={`M ${cx} 0 V ${NODE_Y}`} />,
    );
  }
  if (commit.parents.length > 0) {
    paths.push(<GraphPath key="out" color={circleColor} d={`M ${cx} ${NODE_Y} V ${ROW_HEIGHT}`} />);
  }

  const width = LANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1);
  const isMerge = commit.parents.length > 1;

  return (
    <svg
      aria-hidden="true"
      className="shrink-0 overflow-visible"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
    >
      {paths}
      {row.isHead ? (
        // HEAD: a larger dot with a hollow centre.
        <>
          <circle
            cx={cx}
            cy={NODE_Y}
            r={NODE_RADIUS + 3}
            fill={circleColor}
            stroke="var(--background)"
            strokeWidth={1.5}
          />
          <circle cx={cx} cy={NODE_Y} r={1.5} fill="var(--background)" />
        </>
      ) : isMerge ? (
        <>
          <circle cx={cx} cy={NODE_Y} r={NODE_RADIUS + 1} fill={circleColor} />
          <circle cx={cx} cy={NODE_Y} r={NODE_RADIUS - 1.5} fill="var(--background)" />
        </>
      ) : (
        <circle cx={cx} cy={NODE_Y} r={NODE_RADIUS} fill={circleColor} />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Row + expanded file list
// ---------------------------------------------------------------------------

function RefPill({ itemRef }: { itemRef: CommitRef }) {
  const isHead = itemRef.kind === "head";
  return (
    <span
      title={`${itemRef.name} (${itemRef.kind === "head" ? "current branch" : itemRef.kind})`}
      data-testid={`commits-panel__ref--${itemRef.name}`}
      data-ref-kind={itemRef.kind}
      className={`max-w-[8rem] truncate rounded-full border px-1.5 py-0.5 text-[10px] leading-none ${
        isHead ? "" : "border-border text-muted-foreground"
      }`}
      style={isHead ? { borderColor: GRAPH_REF_COLOR, color: GRAPH_REF_COLOR } : undefined}
    >
      {itemRef.name}
    </span>
  );
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

// Memoized: `row` comes from the memoized row list and `onToggle` is stable,
// so a resize drag or an expand re-renders only the rows that changed.
const CommitRow = memo(function CommitRow({
  row,
  expanded,
  onToggle,
}: {
  row: GraphRow<HistoryCommit>;
  expanded: boolean;
  onToggle: (sha: string) => void;
}) {
  const { commit } = row;
  const visibleRefs = commit.refs.slice(0, 2);
  const hiddenRefs = commit.refs.slice(2);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={() => onToggle(commit.sha)}
      aria-expanded={expanded}
      title={`${commit.subject}\n${commit.sha.slice(0, 7)} · ${commit.author}`}
      data-testid={`commits-panel__row--${commit.sha}`}
      data-head={row.isHead ? "true" : undefined}
      className="grid h-6 w-full min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5 pr-3 pl-1 text-left text-xs hover:bg-accent/50"
    >
      <CommitGraphSlice row={row} />
      <span className="flex min-w-0 items-center gap-1">
        <Chevron className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground">{commit.subject}</span>
      </span>
      {commit.refs.length > 0 && (
        <span className="flex shrink-0 items-center gap-1 overflow-hidden">
          {visibleRefs.map((ref) => (
            <RefPill key={`${ref.kind}:${ref.name}`} itemRef={ref} />
          ))}
          {hiddenRefs.length > 0 && (
            <span
              className="shrink-0 text-[10px] leading-none text-muted-foreground"
              title={hiddenRefs.map((r) => r.name).join(", ")}
              data-testid="commits-panel__more-refs"
            >
              +{hiddenRefs.length}
            </span>
          )}
        </span>
      )}
    </button>
  );
});

/** git name-status codes the Changes badge knows; copies and type changes
 *  fall back to "modified". */
function toFileStatus(code: string): FileStatus {
  return code === "A" || code === "D" || code === "R" ? code : "M";
}

/** The lanes leaving an expanded commit, drawn straight down through its
 *  file list so the graph stays connected to the next row. */
function LaneContinuation({ lanes }: { lanes: GraphLane[] }) {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-1 z-10 h-full"
      width={LANE_WIDTH * (lanes.length + 1)}
    >
      {lanes.map((lane, i) => (
        <line
          // biome-ignore lint/suspicious/noArrayIndexKey: a lane's position is its identity
          key={i}
          x1={LANE_WIDTH * (i + 1)}
          x2={LANE_WIDTH * (i + 1)}
          y1="0"
          y2="100%"
          stroke={lane.color}
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}

function CommitFiles({
  workspaceId,
  row,
  onOpenFile,
}: {
  workspaceId: string;
  row: GraphRow<HistoryCommit>;
  onOpenFile: (sha: string, path: string, pinned: boolean) => void;
}) {
  const { commit, outputSwimlanes } = row;
  // Line text up with the commit subject: row padding + graph + gap.
  const indent = { paddingLeft: 4 + LANE_WIDTH * (Math.max(outputSwimlanes.length, 1) + 1) + 6 };
  // A commit's files never change, so the query never goes stale.
  const detailsQuery = useQuery({
    queryKey: ["commitDetails", workspaceId, commit.sha],
    queryFn: () => trpc.workspace.getCommitDetails.query({ workspaceId, sha: commit.sha }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const meta = [commit.author, dateFormatter.format(commit.ts * 1000), commit.sha.slice(0, 7)].join(
    " · ",
  );
  const files = detailsQuery.data?.files;

  return (
    <div className="relative bg-muted/20" data-testid={`commits-panel__files--${commit.sha}`}>
      <LaneContinuation lanes={outputSwimlanes} />
      <div className="truncate py-1 pr-3 text-[11px] text-muted-foreground" style={indent}>
        {meta}
      </div>
      {detailsQuery.isError ? (
        <div className="py-1 pr-3 text-[11px] text-destructive" style={indent}>
          {detailsQuery.error instanceof Error
            ? detailsQuery.error.message
            : "Failed to load files"}
        </div>
      ) : !files ? (
        <div className="py-1 pr-3 text-[11px] text-muted-foreground" style={indent}>
          Loading files…
        </div>
      ) : files.length === 0 ? (
        <div className="py-1 pr-3 text-[11px] text-muted-foreground" style={indent}>
          No file changes
        </div>
      ) : (
        files.map((file) => {
          const name = file.path.split("/").pop() ?? file.path;
          const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/, "");
          const FileIcon = getFileIcon(name);
          return (
            <button
              key={file.path}
              type="button"
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              onClick={() => onOpenFile(commit.sha, file.path, false)}
              onDoubleClick={() => onOpenFile(commit.sha, file.path, true)}
              data-testid={`commits-panel__file--${file.path}`}
              style={indent}
              className="flex h-6 w-full min-w-0 items-center gap-1.5 pr-3 text-left text-xs hover:bg-accent/50"
            >
              <FileIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                <span className="text-foreground">{name}</span>
                {dir && <span className="ml-1.5 text-[11px] text-muted-foreground">{dir}</span>}
              </span>
              <FileStatusBadge status={toFileStatus(file.status)} />
            </button>
          );
        })
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function CommitsPanel({
  workspaceId,
  visible,
  onOpenFile,
}: {
  workspaceId: string;
  /** False while the sidepanel is collapsed: stops the signature poll. */
  visible: boolean;
  onOpenFile: (sha: string, path: string, pinned: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => readStorage(COLLAPSED_KEY) === "true");
  const [height, setHeight] = useState(() => {
    const stored = Number(readStorage(HEIGHT_KEY));
    return stored > 0 ? clampHeight(stored) : DEFAULT_HEIGHT;
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const active = visible && !collapsed;

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      writeStorage(COLLAPSED_KEY, String(!c));
      return !c;
    });
  }, []);

  const historyQuery = useInfiniteQuery({
    queryKey: ["commitHistory", workspaceId],
    queryFn: ({ pageParam }) =>
      trpc.workspace.getCommitHistory.query({ workspaceId, skip: pageParam, limit: PAGE_SIZE }),
    initialPageParam: 0,
    getNextPageParam: (last: HistoryPage, pages: HistoryPage[]) =>
      last.hasMore ? pages.reduce((n, p) => n + p.commits.length, 0) : undefined,
    enabled: active,
    // The signature poll below decides when the history is stale.
    refetchOnWindowFocus: false,
  });

  // Reload the history when HEAD or any ref moves (commit, checkout,
  // reset, fetch, new branch or tag). Polling the signature is one cheap
  // `git show-ref` instead of a full `git log` every tick.
  const signatureQuery = useQuery({
    queryKey: ["commitHistorySignature", workspaceId],
    queryFn: () => trpc.workspace.getCommitHistorySignature.query({ workspaceId }),
    enabled: active,
    refetchInterval: active ? SIGNATURE_POLL_MS : false,
  });
  const loadedSignature = historyQuery.data?.pages[0]?.signature;
  const { isFetching: historyFetching } = historyQuery;
  // Drop to the first page rather than re-reading every loaded page: each
  // page is its own `git log --topo-order` walk, and remote refs move on
  // every background fetch.
  // The first page stays on screen while it reloads.
  const queryClient = useQueryClient();
  const { refetch: refetchHistory } = historyQuery;
  const reloadHistory = useCallback(() => {
    queryClient.setQueryData<InfiniteData<HistoryPage, number>>(
      ["commitHistory", workspaceId],
      (data) => data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) },
    );
    return refetchHistory();
  }, [queryClient, workspaceId, refetchHistory]);
  const { refetch: refetchSignature } = signatureQuery;
  // Reload once per new signature, so a failing reload is not retried in a
  // loop; the next ref change or the Refresh button tries again.
  const reloadedForRef = useRef<string | null>(null);
  useEffect(() => {
    const current = signatureQuery.data;
    if (current === undefined || loadedSignature === undefined || historyFetching) return;
    if (current === loadedSignature || reloadedForRef.current === current) return;
    reloadedForRef.current = current;
    void reloadHistory();
  }, [signatureQuery.data, loadedSignature, historyFetching, reloadHistory]);

  const pages = historyQuery.data?.pages;
  const rows = useMemo(() => {
    if (!pages) return [];
    return buildGraphRows(
      pages.flatMap((p) => p.commits),
      pages[0]?.head ?? null,
    );
  }, [pages]);
  const hasMore = historyQuery.hasNextPage;

  const toggleExpanded = useCallback((sha: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  }, []);

  // Load the next page when the end of the list scrolls into view. The
  // sentinel is a callback ref held in state, so collapsing and expanding
  // the section (which remounts it) binds a fresh observer.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const { fetchNextPage, isFetchingNextPage } = historyQuery;
  useEffect(() => {
    const root = sentinel?.parentElement;
    if (!sentinel || !root || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { root, rootMargin: "96px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, hasMore, isFetchingNextPage, fetchNextPage]);

  // Drag the top edge to resize; the height persists across reloads.
  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      let latest = startHeight;
      const onMove = (ev: PointerEvent) => {
        latest = clampHeight(startHeight + startY - ev.clientY);
        setHeight(latest);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        writeStorage(HEIGHT_KEY, String(latest));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [height],
  );

  const refresh = useCallback(() => {
    if (collapsed) {
      toggleCollapsed();
      return;
    }
    void refetchSignature();
    void reloadHistory();
  }, [collapsed, toggleCollapsed, refetchSignature, reloadHistory]);

  const count = rows.length;
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div className="relative shrink-0 border-t border-border" data-testid="commits-panel">
      {!collapsed && (
        <div
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
          onPointerDown={startResize}
          data-testid="commits-panel__resize"
        />
      )}
      <div className="flex h-7 items-center gap-1 pr-2 pl-1">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          data-testid="commits-panel__toggle"
          className="flex h-full min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
        >
          <Chevron className="size-3.5 shrink-0" />
          <span>Commits</span>
          {pages && (
            <span
              className="text-[10px] font-medium tabular-nums"
              data-testid="commits-panel__count"
            >
              {count}
              {hasMore ? "+" : ""}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={refresh}
          aria-label="Refresh commits"
          title="Refresh commits"
          data-testid="commits-panel__refresh"
          className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={`size-3.5 ${historyQuery.isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>
      {!collapsed && (
        <div
          className="overflow-y-auto"
          style={{ height: `min(${height}px, 50vh)` }}
          data-testid="commits-panel__list"
        >
          {historyQuery.isError && !pages ? (
            <p className="px-3 py-2 text-[11px] text-destructive">
              {historyQuery.error instanceof Error
                ? historyQuery.error.message
                : "Failed to load commits"}
            </p>
          ) : !pages ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">Loading commits…</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">No commits yet</p>
          ) : (
            <>
              {rows.map((row) => {
                const isExpanded = expanded.has(row.commit.sha);
                return (
                  <div key={row.commit.sha}>
                    <CommitRow row={row} expanded={isExpanded} onToggle={toggleExpanded} />
                    {isExpanded && (
                      <CommitFiles workspaceId={workspaceId} row={row} onOpenFile={onOpenFile} />
                    )}
                  </div>
                );
              })}
              {hasMore && (
                <div ref={setSentinel} className="px-3 py-1">
                  <button
                    type="button"
                    onClick={() => void fetchNextPage()}
                    disabled={isFetchingNextPage}
                    data-testid="commits-panel__load-more"
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
