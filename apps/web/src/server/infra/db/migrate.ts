import { getDb } from "./connection";

export function runMigrations(): void {
  // Migrations run automatically on first getDb() call.
  // This function exists for explicit call sites (e.g. start-server.ts).
  getDb();
}
