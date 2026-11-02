import type {
  AutoMergeInfo,
  MergeMethod,
  MergeQueueInfo,
  MergeQueueState,
} from "@band-app/plugin-api";

/** The GraphQL selection for a pull request's merge queue entry and auto-merge request. */
export const MERGE_QUEUE_FIELDS = `isInMergeQueue
        mergeQueueEntry { state position enqueuedAt estimatedTimeToMerge mergeQueue { entries { totalCount } } }
        autoMergeRequest { enabledAt mergeMethod }`;

/** The merge queue fields of a pull request node. All absent on a host that lacks them. */
export interface MergeQueueNode {
  isInMergeQueue?: boolean;
  mergeQueueEntry?: {
    state: string;
    position: number;
    enqueuedAt: string | null;
    estimatedTimeToMerge: number | null;
    mergeQueue?: { entries?: { totalCount?: number } | null } | null;
  } | null;
  autoMergeRequest?: { enabledAt: string | null; mergeMethod: string | null } | null;
}

const QUEUE_STATES: Record<string, MergeQueueState> = {
  QUEUED: "queued",
  AWAITING_CHECKS: "awaiting_checks",
  MERGEABLE: "mergeable",
  LOCKED: "locked",
  UNMERGEABLE: "unmergeable",
};

const MERGE_METHODS: Record<string, MergeMethod> = {
  MERGE: "merge",
  SQUASH: "squash",
  REBASE: "rebase",
};

/** The pull request's place in the merge queue, or null when it is not in one. */
export function parseMergeQueue(node: MergeQueueNode): MergeQueueInfo | null {
  const entry = node.mergeQueueEntry;
  if (!node.isInMergeQueue || !entry) return null;
  const total = entry.mergeQueue?.entries?.totalCount;
  return {
    state: QUEUE_STATES[entry.state] ?? "queued",
    position: entry.position,
    enqueuedAt: entry.enqueuedAt,
    estimatedTimeToMerge: entry.estimatedTimeToMerge,
    total: typeof total === "number" && total > 0 ? total : null,
  };
}

/** Auto-merge on a pull request that is not in the queue yet, or null. */
export function parseAutoMerge(node: MergeQueueNode): AutoMergeInfo | null {
  const request = node.autoMergeRequest;
  if (!request || node.isInMergeQueue) return null;
  return {
    enabledAt: request.enabledAt,
    method: (request.mergeMethod && MERGE_METHODS[request.mergeMethod]) || null,
  };
}

/**
 * Whether a failed query was refused for the merge queue fields (a GitHub Enterprise Server
 * that predates them), so the caller can ask again without them.
 */
export function isUnknownMergeQueueField(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Match GitHub's schema error, not the field names alone: a timeout's "Command failed: gh api
  // graphql -f query=..." line holds the whole query text and must not switch the fields off.
  return /(?:field\s+['"]?(?:mergeQueueEntry|isInMergeQueue|autoMergeRequest|mergeQueue)['"]?\s+doesn't exist on type|undefinedField.*(?:mergeQueueEntry|isInMergeQueue|autoMergeRequest|mergeQueue))/i.test(
    message,
  );
}
