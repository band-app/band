import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

/**
 * Throws unless `BAND_HOME` points inside the OS temp dir. In-process tests
 * call the services directly, and a service with no `BAND_HOME` opens the
 * developer's real `~/.band/band.db` and migrates it. Call this before the
 * first service call, and again before cleanup.
 */
export function assertTempBandHome(env: NodeJS.ProcessEnv = process.env): string {
  const bandHome = env.BAND_HOME;
  if (!bandHome) {
    throw new Error("BAND_HOME is not set; refusing to let a test open the real ~/.band");
  }
  const real = join(homedir(), ".band");
  if (bandHome === real || bandHome.startsWith(real + sep)) {
    throw new Error(`BAND_HOME points at the real Band home (${real}); refusing to run`);
  }
  const tmp = realpathSync(tmpdir());
  const resolved = (() => {
    try {
      return realpathSync(bandHome);
    } catch {
      return bandHome;
    }
  })();
  if (!resolved.startsWith(tmp + sep) && !bandHome.startsWith(tmpdir() + sep)) {
    throw new Error(`BAND_HOME (${bandHome}) is outside the temp dir ${tmp}; refusing to run`);
  }
  return bandHome;
}
