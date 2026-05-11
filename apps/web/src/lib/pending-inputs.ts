interface PendingInput {
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
  /** Workspace this approval belongs to — used by hasPendingInputForWorkspace
   *  so the dashboard can keep the "needs attention" indicator on while the
   *  agent is still blocked on user input. May be undefined for legacy
   *  call-sites that didn't pass it. */
  workspaceId?: string;
}

// Use globalThis to ensure a single shared state across multiple bundles
const PENDING_KEY = Symbol.for("band.pending-inputs");
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[PENDING_KEY]) g[PENDING_KEY] = new Map<string, PendingInput>();
const pendingInputs = g[PENDING_KEY] as Map<string, PendingInput>;

export function createPendingInput(
  approvalId: string,
  workspaceId?: string,
): Promise<Record<string, string>> {
  return new Promise<Record<string, string>>((resolve, reject) => {
    pendingInputs.set(approvalId, { resolve, reject, workspaceId });
  });
}

export function resolvePendingInput(approvalId: string, answers: Record<string, string>): boolean {
  const pending = pendingInputs.get(approvalId);
  if (!pending) return false;
  pendingInputs.delete(approvalId);
  pending.resolve(answers);
  return true;
}

export function rejectPendingInput(approvalId: string, error: Error): boolean {
  const pending = pendingInputs.get(approvalId);
  if (!pending) return false;
  pendingInputs.delete(approvalId);
  pending.reject(error);
  return true;
}

export function rejectAllPendingInputs(error: Error): void {
  for (const [approvalId, pending] of pendingInputs) {
    pendingInputs.delete(approvalId);
    pending.reject(error);
  }
}

/**
 * Returns true if there is at least one pending input request for the given
 * workspace — meaning the agent is currently blocked on a user-facing
 * AskUserQuestion / ExitPlanMode prompt. clearNeedsAttention uses this so the
 * dashboard indicator stays on while the user still owes the agent an answer.
 */
export function hasPendingInputForWorkspace(workspaceId: string): boolean {
  for (const pending of pendingInputs.values()) {
    if (pending.workspaceId === workspaceId) return true;
  }
  return false;
}
