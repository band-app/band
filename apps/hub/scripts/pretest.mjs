// Builds what the hub suite runs against: the web client and the hub bundle.
// CI builds them once in the `build` job and sets BAND_PREBUILT=1 in the test
// jobs, which unpack that build instead. Locally the variable is unset, so
// `pnpm test` still builds first.
import { spawnSync } from "node:child_process";

if (process.env.BAND_PREBUILT === "1") {
  console.log("[pretest] BAND_PREBUILT=1, using the existing web and hub build");
  process.exit(0);
}

for (const args of [["--filter", "@band-app/web", "build"], ["build"]]) {
  const run = spawnSync("pnpm", args, { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
