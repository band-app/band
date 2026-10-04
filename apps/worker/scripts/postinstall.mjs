// node-pty's prebuilt spawn-helper can land without its execute bit, which
// makes every PTY spawn fail with "posix_spawnp failed". Set it after install.
// Never fails the install: a source build has no prebuilds directory.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform !== "win32") {
  try {
    const prebuilds = join(dirname(createRequire(import.meta.url).resolve("node-pty/package.json")), "prebuilds");
    if (existsSync(prebuilds)) {
      for (const dir of readdirSync(prebuilds)) {
        const helper = join(prebuilds, dir, "spawn-helper");
        if (existsSync(helper)) chmodSync(helper, 0o755);
      }
    }
  } catch {
    // node-pty is not resolvable from here; nothing to fix.
  }
}
