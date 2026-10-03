/**
 * Infra-tier accessor for the persisted Band auth token.
 *
 * Reads through `SettingsQueries.getOrCreateToken` so this module stays
 * within the Infra tier (no service imports). The cloudflared tunnel
 * client consumes this rather than reaching up through `services/` for
 * the same value — see `docs/web-architecture.md` for the tier rules.
 */

import { SettingsQueries } from "../db/queries/settings";

const settingsQueries = new SettingsQueries();

export function getToken(): string {
  return settingsQueries.getOrCreateToken();
}
