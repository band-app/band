/**
 * Open sockets grouped by the key they authenticated with (a token id), so
 * everything one credential opened can be closed together.
 */

interface RegistrySocket {
  destroy(): void;
  once(event: "close", listener: () => void): unknown;
}

export class SocketRegistry {
  private readonly byKey = new Map<string, Set<RegistrySocket>>();

  /** Tracks `socket` under `key` until it closes. */
  add(key: string, socket: RegistrySocket): void {
    let set = this.byKey.get(key);
    if (!set) {
      set = new Set();
      this.byKey.set(key, set);
    }
    const sockets = set;
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0 && this.byKey.get(key) === sockets) this.byKey.delete(key);
    });
  }

  /** Destroys every socket tracked under `key`. */
  closeAll(key: string): void {
    for (const socket of this.byKey.get(key) ?? []) socket.destroy();
    this.byKey.delete(key);
  }
}
