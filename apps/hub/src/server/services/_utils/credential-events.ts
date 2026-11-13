/**
 * Vault changes that must reach workers holding a copy: a worker profile maps vault items to
 * files, so a replaced or deleted item has to be rewritten on those workers. The vault service
 * says what changed and knows nothing about workers; the secrets service listens. A direct import
 * the other way would be a cycle.
 */
export type CredentialChange =
  /** A vault item was replaced or deleted. */
  { kind: "vault-item"; itemId: string; name: string };

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
