// Copies the built UI (`apps/web/dist/client`) into `dist/client` so the npm
// tarball carries it beside the server bundle, where `start-server.ts` looks
// when no `--ui-dir` is given and the web workspace is absent. `--clean`
// removes the copy again so a later `pnpm build` of the UI isn't shadowed.
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const target = join(import.meta.dirname, "..", "dist", "client");
rmSync(target, { recursive: true, force: true });
if (!process.argv.includes("--clean")) {
  const source = join(import.meta.dirname, "..", "..", "web", "dist", "client");
  if (!existsSync(source)) {
    console.error(`UI build not found at ${source}. Run \`pnpm build\` first.`);
    process.exit(1);
  }
  cpSync(source, target, { recursive: true });
}
