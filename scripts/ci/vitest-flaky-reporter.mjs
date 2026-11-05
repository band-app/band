// Vitest reporter for CI: records every test that failed and then passed on a retry.
// The line goes to the log (and a GitHub annotation), and a JSON file in $BAND_FLAKY_DIR
// is what scripts/ci/report-flaky.mjs reads. Nothing is written when no test flaked.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

export default class FlakyReporter {
  onTestRunEnd(testModules) {
    const tests = [];
    for (const mod of testModules) {
      for (const testCase of mod.children.allTests()) {
        const diag = testCase.diagnostic();
        if (!diag?.flaky) continue;
        const names = testCase.fullName.split(" > ");
        tests.push({
          file: relative(repoRoot, mod.moduleId),
          name: names.join(" › "),
          retries: diag.retryCount,
        });
      }
    }
    if (!tests.length) return;
    for (const t of tests) {
      console.log(`::warning title=Flaky test::${t.file} › ${t.name} passed only on retry ${t.retries}`);
    }
    const dir = process.env.BAND_FLAKY_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `vitest-${basename(process.cwd())}-${process.pid}-${Date.now()}.json`);
    writeFileSync(file, `${JSON.stringify({ tool: "vitest", tests }, null, 2)}\n`);
  }
}
