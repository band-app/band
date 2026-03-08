interface PendingInput {
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
}

const pendingInputs = new Map<string, PendingInput>();

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
