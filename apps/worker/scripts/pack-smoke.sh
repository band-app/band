#!/usr/bin/env bash
# Packs the worker, installs the tarball into an empty directory with npm and
# runs `band-worker --help` from there. Proves the published files and
# dependencies are enough, with no workspace around them.
set -euo pipefail

cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pnpm pack --pack-destination "$tmp"
tarball="$(ls "$tmp"/band-app-worker-*.tgz)"

# The platform package that carries the band CLI is not on npm until a release, so
# make it from a local binary and install it beside the worker tarball.
platform="$(node -p "process.platform + '-' + process.arch")"
cli_bin="${BAND_CLI_PATH:-}"
for candidate in ../cli/target/release/band ../cli/target/debug/band; do
  [ -n "$cli_bin" ] && break
  [ -x "$candidate" ] && cli_bin="$candidate"
done
if [ -z "$cli_bin" ]; then
  echo "no band CLI to package: build apps/cli or set BAND_CLI_PATH" >&2
  exit 1
fi
node scripts/cli-packages.mjs --version 0.0.0-smoke --out "$tmp/cli" --binary "$platform=$cli_bin" >/dev/null
(cd "$tmp/cli/worker-cli-$platform" && npm pack --silent --pack-destination "$tmp" >/dev/null)
cli_tarball="$(ls "$tmp"/band-app-worker-cli-*.tgz)"

mkdir "$tmp/install"
cd "$tmp/install"
npm init -y >/dev/null
npm install --no-audit --no-fund "$tarball" "$cli_tarball"

# npm ignores pnpm-lock.yaml, so the pinned sdk must win over the newest release
# that claude-agent-sdk's open peer range would otherwise pull in.
sdk_version="$(node -p "require('./node_modules/@anthropic-ai/sdk/package.json').version")"
if [ "$sdk_version" != "$(node -p "require('./node_modules/@band-app/worker/package.json').dependencies['@anthropic-ai/sdk']")" ]; then
  echo "@anthropic-ai/sdk resolved to $sdk_version, not the pinned version" >&2
  exit 1
fi
echo "@anthropic-ai/sdk $sdk_version"

./node_modules/.bin/band-worker --help | tee help.txt
grep -q -- '--hub <url>' help.txt

# The native dependencies must work from the install: a PTY has to start and
# ripgrep has to resolve its binary.
node -e "
const pty = require('node-pty');
const p = pty.spawn('/bin/sh', ['-c', 'echo pty-ok'], {});
let out = '';
p.onData((d) => { out += d; });
p.onExit(async () => {
  if (!out.includes('pty-ok')) { console.error('pty output: ' + out); process.exit(1); }
  const { rgPath } = await import('@vscode/ripgrep');
  require('node:fs').accessSync(rgPath, require('node:fs').constants.X_OK);
  console.log('node-pty and ripgrep work');
});
"

# The worker's lookup (resolveCliBinary in src/cli.ts) finds the CLI through
# require.resolve of the platform package from the installed worker.
node -e "
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const { execFileSync } = require('node:child_process');
const req = createRequire(require.resolve('@band-app/worker/package.json'));
const pkg = '@band-app/worker-cli-' + process.platform + '-' + process.arch;
const bin = join(dirname(req.resolve(pkg + '/package.json')), 'bin', 'band');
console.log('band resolved to ' + bin);
console.log(execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim());
"
