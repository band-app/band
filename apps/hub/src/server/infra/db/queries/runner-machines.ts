/** Persistence for `runner_machines`: the machines runner hooks started (plan step 3.7). */

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "../connection";
import { runnerMachines } from "../schema";

export type RunnerMachineRow = typeof runnerMachines.$inferSelect;
export type RunnerMachineState = RunnerMachineRow["state"];

/** States in which a machine may still exist. */
export const LIVE_STATES: RunnerMachineState[] = ["spawning", "running", "stopping"];

export class RunnerMachineQueries {
  insert(row: RunnerMachineRow): void {
    getDb().insert(runnerMachines).values(row).run();
  }

  get(id: string): RunnerMachineRow | undefined {
    return getDb().select().from(runnerMachines).where(eq(runnerMachines.id, id)).get();
  }

  update(id: string, fields: Partial<Omit<RunnerMachineRow, "id">>): void {
    getDb().update(runnerMachines).set(fields).where(eq(runnerMachines.id, id)).run();
  }

  /** Machines that may still exist, oldest first. */
  listLive(): RunnerMachineRow[] {
    return getDb()
      .select()
      .from(runnerMachines)
      .where(inArray(runnerMachines.state, LIVE_STATES))
      .orderBy(runnerMachines.spawnedAt)
      .all();
  }

  /** The newest `limit` machines in any state. */
  list(limit: number): RunnerMachineRow[] {
    return getDb()
      .select()
      .from(runnerMachines)
      .orderBy(desc(runnerMachines.spawnedAt))
      .limit(limit)
      .all();
  }

  /** Machines of a worker id still in a live state, except `exceptId`. */
  liveForWorker(workerId: string, exceptId: string): RunnerMachineRow[] {
    return getDb()
      .select()
      .from(runnerMachines)
      .where(
        and(
          eq(runnerMachines.workerId, workerId),
          inArray(runnerMachines.state, LIVE_STATES),
          ne(runnerMachines.id, exceptId),
        ),
      )
      .all();
  }

  /** Marks the `lost` machines of a runner with this handle as destroyed. */
  settleHandle(runnerId: string, handle: string, note: string): void {
    getDb()
      .update(runnerMachines)
      .set({ state: "destroyed", destroyedAt: Date.now(), error: note })
      .where(
        and(
          eq(runnerMachines.runnerId, runnerId),
          eq(runnerMachines.handle, handle),
          eq(runnerMachines.state, "lost"),
        ),
      )
      .run();
  }
}
