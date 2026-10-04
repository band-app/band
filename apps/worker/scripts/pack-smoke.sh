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

mkdir "$tmp/install"
cd "$tmp/install"
npm init -y >/dev/null
npm install --no-audit --no-fund "$tarball"

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
