/** Persistence for quick commands (`quick_commands`). */

import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { quickCommands } from "../schema";

export interface QuickCommandRow {
  id: string;
  label: string;
  repoName: string | null;
  action: string;
  command: string;
  appendEnter: boolean;
  agentId: string | null;
  prompt: string;
  lastRunAt: number | null;
  createdAt: number;
}

export class QuickCommandQueries {
  list(): QuickCommandRow[] {
    return getDb().select().from(quickCommands).all();
  }

  find(id: string): QuickCommandRow | undefined {
    return getDb().select().from(quickCommands).where(eq(quickCommands.id, id)).get();
  }

  insert(row: QuickCommandRow): void {
    getDb().insert(quickCommands).values(row).run();
  }

  update(id: string, patch: Partial<Omit<QuickCommandRow, "id" | "createdAt">>): void {
    getDb().update(quickCommands).set(patch).where(eq(quickCommands.id, id)).run();
  }

  remove(id: string): void {
    getDb().delete(quickCommands).where(eq(quickCommands.id, id)).run();
  }

  removeForRepo(repoName: string): void {
    getDb().delete(quickCommands).where(eq(quickCommands.repoName, repoName)).run();
  }
}
