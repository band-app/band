// Builds the worker for the desktop app into dist-desktop/, which electron-builder
// ships as Resources/worker. Unlike the npm bundle (scripts/build.mjs), nothing is
// installed on the user's machine, so every pure-JS dependency is bundled and only
// the native modules sit beside it in node_modules: node-pty and the ripgrep binary.
//
// Layout, which the worker's own lookups expect:
//   band-worker.mjs, terminal-daemon.mjs   the worker and its terminal daemon
//   agents/<name>.mjs                      the ACP adapters (acp-launch.ts looks next to the bundle)
//   node_modules/node-pty, node_modules/@vscode/ripgrep(+ platform packages)
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-desktop");
const require = createRequire(join(root, "package.json"));
const banner = "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const [entry, outfile] of [
  ["src/main.ts", "band-worker.mjs"],
  ["src/terminal-daemon.ts", "terminal-daemon.mjs"],
]) {
  await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: join(out, outfile),
    external: ["node-pty", "@vscode/ripgrep"],
    banner: { js: banner },
    logLevel: "warning",
  });
}

for (const adapter of ["claude-agent-acp", "codex-acp"]) {
  const pkgDir = dirname(require.resolve(`@agentclientprotocol/${adapter}/package.json`));
  await build({
    entryPoints: [join(pkgDir, "dist", "index.js")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(out, "agents", `${adapter}.mjs`),
    banner: { js: banner },
    logLevel: "warning",
  });
}

// node-pty: the loader tries build/Release, then prebuilds/<platform>-<arch>.
const pty = dirname(require.resolve("node-pty/package.json"));
const ptyOut = join(out, "node_modules", "node-pty");
mkdirSync(ptyOut, { recursive: true });
cpSync(join(pty, "package.json"), join(ptyOut, "package.json"));
cpSync(join(pty, "lib"), join(ptyOut, "lib"), { recursive: true, dereference: true });
if (existsSync(join(pty, "build", "Release"))) {
  mkdirSync(join(ptyOut, "build", "Release"), { recursive: true });
  for (const f of readdirSync(join(pty, "build", "Release")).filter((n) => n.endsWith(".node"))) {
    cpSync(join(pty, "build", "Release", f), join(ptyOut, "build", "Release", f));
  }
}
const prebuilds = join(pty, "prebuilds");
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds).filter((n) => n.startsWith(`${process.platform}-`))) {
    cpSync(join(prebuilds, dir), join(ptyOut, "prebuilds", dir), {
      recursive: true,
      filter: (src) => !src.endsWith(".pdb"),
    });
    const helper = join(ptyOut, "prebuilds", dir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

// ripgrep: the wrapper resolves `@vscode/ripgrep-<platform>-<arch>/bin/rg` as a sibling.
const rg = realpathSync(join(root, "node_modules", "@vscode", "ripgrep"));
const rgOut = join(out, "node_modules", "@vscode", "ripgrep");
mkdirSync(join(rgOut, "lib"), { recursive: true });
cpSync(join(rg, "package.json"), join(rgOut, "package.json"));
cpSync(join(rg, "lib", "index.js"), join(rgOut, "lib", "index.js"));
const rgRequire = createRequire(join(rg, "package.json"));
const rgName = process.platform === "win32" ? "rg.exe" : "rg";
for (const arch of ["x64", "arm64"]) {
  const pkg = `@vscode/ripgrep-${process.platform}-${arch}`;
  let pkgDir;
  try {
    pkgDir = dirname(rgRequire.resolve(`${pkg}/package.json`));
  } catch {
    if (arch === process.arch) throw new Error(`ripgrep package ${pkg} not found`);
    console.warn(`warning: ${pkg} not found, skipping`);
    continue;
  }
  const dest = join(out, "node_modules", pkg);
  mkdirSync(join(dest, "bin"), { recursive: true });
  cpSync(join(pkgDir, "package.json"), join(dest, "package.json"));
  cpSync(join(pkgDir, "bin", rgName), join(dest, "bin", rgName));
  chmodSync(join(dest, "bin", rgName), 0o755);
}

console.log(`worker for the desktop app written to ${out}`);
