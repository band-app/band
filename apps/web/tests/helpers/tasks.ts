// Shared task-related HTTP helpers for integration tests. Promoted here
// because `listTasksForWorkspace` was being inlined verbatim in two
// integration tests (`workspace-create-via.test.ts` and the
// maxTurns-strip suite); the duplication has the same drift risk that
// motivated the `waitFor` extraction in `wait-for.ts`.
//
// Kept in its own file rather than tacked onto `server.ts` so the
// generic server-boot helpers stay focused on the wire (server lifecycle,
// raw tRPC HTTP shape) and domain-shaped helpers like this one can grow
// independently as new tests need them.

import { expect } from "vitest";
import { trpcQuery } from "./server";

export interface TaskListItem {
  id: string;
  workspaceId: string;
  prompt: string;
  status: string;
}

/**
 * Query `tasks.list` for the given workspace and return the typed array.
 * Asserts a 200 status with the raw body as the failure message — a 500
 * here (e.g. a migration that left a column reference dangling) would
 * otherwise surface as a confusing JSON parse error several lines later.
 */
export async function listTasksForWorkspace(
  serverUrl: string,
  workspaceId: string,
  token: string,
): Promise<TaskListItem[]> {
  const res = await trpcQuery(serverUrl, "tasks.list", { workspaceId }, token);
  const body = await res.text();
  expect(res.status, `tasks.list failed: ${body}`).toBe(200);
  return (JSON.parse(body) as { result: { data: { tasks: TaskListItem[] } } }).result.data.tasks;
}
