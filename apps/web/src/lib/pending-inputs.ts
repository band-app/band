interface PendingInput {
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
}

// Use globalThis to ensure a single shared state across multiple bundles
const PENDING_KEY = Symbol.for("band.pending-inputs");
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[PENDING_KEY]) g[PENDING_KEY] = new Map<string, PendingInput>();
const pendingInputs = g[PENDING_KEY] as Map<string, PendingInput>;

export function createPendingInput(approvalId: string): Promise<Record<string, string>> {
  return new Promise<Record<string, string>>((resolve, reject) => {
    pendingInputs.set(approvalId, { resolve, reject });
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
