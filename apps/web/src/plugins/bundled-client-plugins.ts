import type { ClientPlugin } from "@band-app/plugin-api/client";

/**
 * The client halves of the bundled plugins, compiled into the dashboard. The
 * server halves are in `src/server/services/bundled-plugins.ts`. No bundled
 * plugin has a client half: the Checks panel is drawn by the core for any
 * review provider (`components/review`).
 */
export const BUNDLED_CLIENT_PLUGINS: ClientPlugin[] = [];
