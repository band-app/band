#!/usr/bin/env node
// Picks the web e2e specs a pull request affects. Everywhere but a pull request,
// and on any error, it selects every spec. See CLAUDE.md, "Where tests run".
//
//   node scripts/ci/affected-e2e.mjs --event pull_request --base <sha> --head <sha> [--github-output]
//
// Output: `mode=all|subset`, `specs=<space separated paths relative to apps/web>`,
// `matrix=<json for the shard matrix>`. A missed mapping is caught by the merge queue,
// which runs every spec.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Broad specs that run on every pull request, whatever changed.
export const SMOKE_SPECS = [
  "apps/web/e2e/worktree-switch-no-remount.spec.ts",
  "apps/web/e2e/chat-send-optimistic.spec.ts",
  "apps/web/e2e/terminal-visible-output.spec.ts",
  "apps/web/e2e/settings-page.spec.ts",
  "apps/web/e2e/sidebar-grouping.spec.ts",
];

// A subset larger than this runs in three shards.
const SHARD_THRESHOLD = 40;

// Changes that can alter any spec: the hub, workers, shared packages, plugins, the CLI the
// helpers shell out to, the e2e config, dependencies and CI itself.
const FULL_PATTERNS = [
  /^apps\/hub\/(src|scripts|package\.json|vitest\.config\.ts)/,
  /^apps\/hub\/tests\/(fixtures|helpers)\//,
  /^apps\/worker\//,
  /^apps\/cli\/(src|skills|Cargo)/,
  /^packages\//,
  /^plugins\//,
  /^apps\/web\/(package\.json|playwright\.config\.ts|vite\.config\.ts|tsconfig[^/]*\.json|index\.html)$/,
  /^apps\/web\/(public|scripts)\//,
  /^apps\/web\/src\/routeTree\.gen\.ts$/,
  /^apps\/web\/src\/routes\/__root\.tsx$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^package\.json$/,
  /^\.nvmrc$/,
  /^scripts\/(test-env|test-process-guard|with-timeout)\.mjs$/,
  /^\.github\/(workflows|actions)\//,
  /^scripts\/ci\//,
];

// Changes that no web e2e spec can observe.
const IGNORED_PATTERNS = [
  /^docs\//,
  /^apps\/website\//,
  /^apps\/mobile\//,
  /^apps\/desktop\//,
  /^apps\/web\/e2e-desktop\//,
  /^apps\/hub\/tests\//,
  /^apps\/web\/tests\//,
  /^\.am\//,
  /^\.claude\//,
  /^\.husky\//,
  /\.md$/,
  /^LICENSE$/,
];

const matches = (patterns, file) => patterns.some((p) => p.test(file));

function walk(dir, accept, out = []) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, accept, out);
    else if (accept(path)) out.push(path);
  }
  return out;
}

const read = (path) => readFileSync(join(root, path), "utf8");

// Relative import specifiers of a source file, resolved to repo paths when the file exists.
function localImports(path, text, candidates) {
  const out = [];
  const re = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const base = relative(root, resolve(root, dirname(path), m[1])).replaceAll("\\", "/");
    const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) =>
      candidates.has(c),
    );
    if (hit) out.push(hit);
  }
  return out;
}

// Static prefixes of the test ids in a file: `data-testid="a"`, `getByTestId("a")` and
// template literals, which count up to the first `${`.
function testIds(text) {
  const ids = new Set();
  const re =
    /(?:data-testid\s*=\s*\{?\s*|getByTestId\(\s*|testId\s*[:=]\s*\{?\s*)["'`]([^"'`$]+)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) ids.add(m[1]);
  return ids;
}

const idsOverlap = (a, b) => {
  for (const x of a) for (const y of b) if (x.startsWith(y) || y.startsWith(x)) return true;
  return false;
};

// The result: { mode: "all" | "subset", specs: string[], reason: string }.
export function selectSpecs(changed) {
  const allSpecs = walk("apps/web/e2e", (p) => /^apps\/web\/e2e\/[^/]+\.spec\.ts$/.test(p)).sort();
  const all = (reason) => ({ mode: "all", specs: allSpecs, reason });

  if (changed.length === 0) return all("no changed files found");

  const e2eFiles = walk("apps/web/e2e", (p) => /\.(ts|tsx)$/.test(p));
  const e2eSet = new Set(e2eFiles);
  const e2eText = new Map(e2eFiles.map((f) => [f, read(f)]));
  const selected = new Set(SMOKE_SPECS.filter((s) => existsSync(join(root, s))));

  // Transitive local imports of each spec (pages, helpers, fixtures).
  const closure = new Map();
  for (const spec of allSpecs) {
    const seen = new Set([spec]);
    const queue = [spec];
    while (queue.length) {
      const f = queue.pop();
      for (const dep of localImports(f, e2eText.get(f), e2eSet)) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    closure.set(spec, seen);
  }
  const specIds = new Map(
    allSpecs.map((spec) => {
      const ids = new Set();
      for (const f of closure.get(spec)) for (const id of testIds(e2eText.get(f))) ids.add(id);
      return [spec, ids];
    }),
  );

  let webSrc = null; // loaded on first use
  const loadSrc = () => {
    if (webSrc) return webSrc;
    const files = walk("apps/web/src", (p) => /\.(ts|tsx)$/.test(p));
    const set = new Set(files);
    const text = new Map(files.map((f) => [f, read(f)]));
    const importers = new Map();
    for (const f of files) {
      for (const dep of localImports(f, text.get(f), set)) {
        importers.set(dep, [...(importers.get(dep) ?? []), f]);
      }
    }
    webSrc = { text, importers, set };
    return webSrc;
  };

  for (const file of changed) {
    if (matches(FULL_PATTERNS, file)) return all(`${file} can affect every spec`);
    if (matches(IGNORED_PATTERNS, file)) continue;

    if (/^apps\/web\/e2e\/[^/]+\.spec\.ts$/.test(file)) {
      if (allSpecs.includes(file)) selected.add(file);
      continue;
    }
    if (file.startsWith("apps/web/e2e/")) {
      // Page object, fixture or helper: every spec that imports it, directly or not.
      if (!e2eSet.has(file)) {
        // Deleted or non-code file under e2e: a stale reference is possible, run everything.
        if (/\.(ts|tsx)$/.test(file)) return all(`${file} is gone, imports may be stale`);
        continue;
      }
      const users = allSpecs.filter((s) => closure.get(s).has(file));
      if (users.length === 0 && !/\.(ts|tsx)$/.test(file)) return all(`${file} has no importer`);
      for (const s of users) selected.add(s);
      continue;
    }
    if (file.startsWith("apps/web/src/")) {
      if (/\.(css|svg|png|ico|woff2?)$/.test(file)) continue; // style or asset only: smoke set
      if (!/\.(ts|tsx)$/.test(file)) return all(`${file} is not mapped`);
      const src = loadSrc();
      if (!src.set.has(file)) return all(`${file} is gone, importers unknown`);
      // Test ids of the file itself. A file with none (a hook, a lib) borrows the ids of what
      // imports it, up to two levels.
      let ids = testIds(src.text.get(file));
      let layer = [file];
      const seen = new Set(layer);
      for (let depth = 0; depth < 2 && ids.size === 0; depth++) {
        const next = [];
        for (const f of layer) {
          for (const up of src.importers.get(f) ?? []) {
            if (seen.has(up)) continue;
            seen.add(up);
            next.push(up);
            for (const id of testIds(src.text.get(up))) ids.add(id);
          }
        }
        layer = next;
      }
      if (ids.size === 0) return all(`${file} has no test id reachable from a spec`);
      const hits = allSpecs.filter((s) => idsOverlap(ids, specIds.get(s)));
      if (hits.length === 0) return all(`${file} matches no spec by test id`);
      for (const s of hits) selected.add(s);
      continue;
    }
    // Anything else (root configs, scripts, unknown locations) is unmapped.
    return all(`${file} is not mapped`);
  }

  const specs = [...selected].sort();
  if (specs.length >= allSpecs.length) return all("the selection covers every spec");
  return { mode: "subset", specs, reason: `${specs.length} of ${allSpecs.length} specs` };
}

export function matrixFor(result) {
  const shards = result.mode === "all" || result.specs.length > SHARD_THRESHOLD ? 3 : 1;
  return { shard: Array.from({ length: shards }, (_, i) => i + 1), total: [shards] };
}

function changedFromGit(base, head) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  const event = arg("event") ?? "pull_request";
  let result;
  try {
    if (event !== "pull_request") {
      result = selectSpecs(["pnpm-lock.yaml"]);
      result.reason = `${event} runs every spec`;
    } else {
      const input = arg("files");
      const changed = input ? readFileSync(input, "utf8").split("\n").filter(Boolean) : changedFromGit(arg("base"), arg("head"));
      result = selectSpecs(changed);
    }
  } catch (err) {
    console.error(`affected-e2e: ${err?.message ?? err}; running every spec`);
    result = { mode: "all", specs: [], reason: "selection failed" };
  }
  const specs = result.mode === "all" ? [] : result.specs.map((s) => s.replace(/^apps\/web\//, ""));
  const lines = {
    mode: result.mode,
    specs: specs.join(" "),
    matrix: JSON.stringify(matrixFor(result)),
  };
  console.log(`affected-e2e: ${result.mode} (${result.reason})`);
  for (const s of specs) console.log(`  ${s}`);
  if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
