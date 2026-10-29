/**
 * Credential changes that must reach agents already running with the old credential. The login
 * and vault services say what changed and know nothing about agents, and the agent session
 * service, which imports both, listens. A direct import the other way would be a cycle.
 */
export type CredentialChange =
  /** A login was removed, replaced or re-chosen. `loginId` is set when its secret or row changed. */
  | { kind: "agent-login"; agentType?: string; chatId?: string; loginId?: string }
  /** A vault git credential was replaced or deleted, so a `GH_TOKEN` taken from it is stale. */
  | { kind: "git-credential" }
  /** A vault item was replaced or deleted. A login that reads it may have given an agent its secret. */
  | { kind: "vault-item"; itemId: string };

const listeners = new Set<(change: CredentialChange) => void>();

export function onCredentialChange(listener: (change: CredentialChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function credentialChanged(change: CredentialChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // A listener that throws must not undo the change that was already made.
    }
  }
}
