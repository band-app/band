import type { ClientPlugin } from "@band-app/plugin-api/client";
import simulatorClient from "@band-app/plugin-simulator/client";

/**
 * The client halves of the bundled plugins, compiled into the dashboard. The
 * server halves are in `src/server/services/bundled-plugins.ts`. The Checks
 * panel is drawn by the core for any review provider (`components/review`);
 * the simulator contributes the Simulator tab.
 */
export const BUNDLED_CLIENT_PLUGINS: ClientPlugin[] = [simulatorClient];
