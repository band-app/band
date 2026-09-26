/**
 * Swimlane layout for the Commits panel's graph, ported from Orca's
 * `shared/git-history-graph.ts` (itself VS Code's SCM graph algorithm).
 *
 * Each row records the lanes entering it from above (`inputSwimlanes`) and
 * leaving it below (`outputSwimlanes`), each lane naming the commit it is
 * heading towards. That is all a row needs to draw its own slice of the
 * graph, so rows render independently and a new page of history only
 * appends rows. Input must be in topological order (`git log
 * --topo-order`), children before parents.
 */

/** Lane colour of the branch HEAD is on. */
export const GRAPH_REF_COLOR = "#3b82f6";

/** Colours handed out, in rotation, to other lanes. */
const GRAPH_LANE_COLORS = ["#22c55e", "#a855f7", "#f97316", "#ec4899", "#14b8a6"] as const;

export interface GraphCommit {
  sha: string;
  parents: string[];
  refs: { name: string; kind: "head" | "branch" | "remote" | "tag" }[];
}

export interface GraphLane {
  /** The commit this lane is heading towards. */
  id: string;
  color: string;
}

export interface GraphRow<C extends GraphCommit = GraphCommit> {
  commit: C;
  inputSwimlanes: GraphLane[];
  outputSwimlanes: GraphLane[];
  isHead: boolean;
}

/** The HEAD branch's lane is blue; every other lane takes the next colour. */
function labelColor(commit: GraphCommit): string | undefined {
  return commit.refs.some((r) => r.kind === "head") ? GRAPH_REF_COLOR : undefined;
}

export function buildGraphRows<C extends GraphCommit>(
  commits: readonly C[],
  head: string | null,
): GraphRow<C>[] {
  let colorIndex = -1;
  const rows: GraphRow<C>[] = [];
  let bySha: Map<string, C> | undefined;

  for (const commit of commits) {
    const inputSwimlanes = (rows.at(-1)?.outputSwimlanes ?? []).map((n) => ({ ...n }));
    const outputSwimlanes: GraphLane[] = [];
    let firstParentAdded = false;

    // Lanes heading to this commit end here; the first of them continues
    // down towards the first parent, the others are dropped.
    if (commit.parents.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === commit.sha) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: commit.parents[0],
              color: labelColor(commit) ?? node.color,
            });
            firstParentAdded = true;
          }
          continue;
        }
        outputSwimlanes.push({ ...node });
      }
    }

    // A new lane per parent not already continued above.
    for (let i = firstParentAdded ? 1 : 0; i < commit.parents.length; i++) {
      let color: string | undefined;
      if (i === 0) {
        color = labelColor(commit);
      } else {
        // Side-parent colours need a lookup; build the index lazily so a
        // linear history never pays for it.
        if (!bySha) {
          bySha = new Map();
          for (const c of commits) if (!bySha.has(c.sha)) bySha.set(c.sha, c);
        }
        const parent = bySha.get(commit.parents[i]);
        color = parent ? labelColor(parent) : undefined;
      }
      if (!color) {
        colorIndex = (colorIndex + 1) % GRAPH_LANE_COLORS.length;
        color = GRAPH_LANE_COLORS[colorIndex];
      }
      outputSwimlanes.push({ id: commit.parents[i], color });
    }

    rows.push({ commit, inputSwimlanes, outputSwimlanes, isHead: commit.sha === head });
  }
  return rows;
}

/** The lane a row's commit dot sits in. */
export function commitLaneIndex(row: GraphRow): number {
  const i = row.inputSwimlanes.findIndex((n) => n.id === row.commit.sha);
  return i !== -1 ? i : row.inputSwimlanes.length;
}

/** The output lane a merge's side parent leaves on, or -1. */
export function mergeParentLaneIndex(row: GraphRow, parentSha: string): number {
  for (let i = row.outputSwimlanes.length - 1; i >= 0; i--) {
    if (row.outputSwimlanes[i].id === parentSha) return i;
  }
  return -1;
}
