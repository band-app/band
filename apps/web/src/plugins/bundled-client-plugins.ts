import type { ClientPlugin } from "@band-app/plugin-api/client";
import githubClient from "@band-app/plugin-github/client";

/**
 * The client halves of the bundled plugins, compiled into the dashboard. The
 * server halves are in `src/server/services/bundled-plugins.ts`.
 */
export const BUNDLED_CLIENT_PLUGINS: ClientPlugin[] = [githubClient];
