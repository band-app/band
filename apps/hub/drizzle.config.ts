import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/infra/db/schema.ts",
  out: "./src/server/infra/db/migrations",
  dialect: "sqlite",
});
