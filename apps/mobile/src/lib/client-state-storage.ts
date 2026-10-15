/**
 * The storage the client-state store reads and writes, backed by AsyncStorage. Each hub has its
 * own key prefix, so two paired hubs keep separate collapsed repos.
 */

import {
  type AsyncKeyValueStore,
  type ClientStateStorage,
  createCachedStorage,
} from "@band-app/client/client-state";

export function createClientStateStorage(
  backend: AsyncKeyValueStore,
  hubId: string,
): ClientStateStorage & { load(): Promise<void> } {
  const prefix = `band-client-state:${hubId}:`;
  return createCachedStorage({
    async getAllKeys() {
      return (await backend.getAllKeys())
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    },
    async multiGet(keys) {
      const rows = await backend.multiGet(keys.map((key) => prefix + key));
      return rows.map(([key, value]) => [key.slice(prefix.length), value] as const);
    },
    setItem: (key, value) => backend.setItem(prefix + key, value),
    removeItem: (key) => backend.removeItem(prefix + key),
  });
}
