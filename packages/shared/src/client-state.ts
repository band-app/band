/**
 * Client-state types shared by the server and the dashboard.
 *
 * Client state is small UI state (open center tabs, panel widths, drafts, …)
 * that the dashboard keeps on the Band server so every device shows the same
 * thing. Each entry has a scope: `all` is one value for every device, and
 * `desktop` / `mobile` hold a separate value per device type.
 *
 * Every write names the version it was based on. The server refuses a write
 * whose base is not the current version, so a client that missed another
 * device's change (offline, reconnecting) can never overwrite it.
 */

export type ClientStateScope = "all" | "desktop" | "mobile";

export type DeviceType = "desktop" | "mobile";

export interface ClientStateEntry {
  key: string;
  scope: ClientStateScope;
  /** The workspace the key belongs to, or null for a global key. */
  workspaceId: string | null;
  /** The stored JSON value, or null once the key has been deleted. */
  value: unknown;
  /** Starts at 1 and goes up by one on every write, including a delete. */
  version: number;
  updatedAt: number;
}

export type ClientStateWriteResult =
  | { ok: true; entry: ClientStateEntry }
  /** The write's base version was stale; `entry` is the server's current row. */
  | { ok: false; entry: ClientStateEntry };

/** Largest serialized value the server accepts, in bytes. */
export const CLIENT_STATE_MAX_VALUE_BYTES = 256 * 1024;
