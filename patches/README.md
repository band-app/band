# xterm.js patches

pnpm applies these through `patchedDependencies` in `pnpm-workspace.yaml`. They
fix bugs that xterm.js has not released. Both come from
[orca](https://github.com/stablyai/orca) (`config/patches/`), which pins the
same xterm.js commit.

| Package | Fixes |
| --- | --- |
| `@xterm/addon-serialize@0.15.0-beta.300` | The server replays a terminal on reconnect with `serialize()`. Unpatched, it loses bold after dim text (`\e[1;22m` clears the bold it just set), drops OSC 8 hyperlinks, writes `\e[0C`/`\e[0D` (which move one column, not zero) at some wrapped-row boundaries, and does not reproduce empty cells with inverse video. |
| `@xterm/addon-search@0.17.0-beta.300` | The find bar overflows the stack or freezes on one very long wrapped line, and whole-word or regex search can stop at the first rejected match on a line. Submitted upstream as [xtermjs/xterm.js#6149](https://github.com/xtermjs/xterm.js/pull/6149); drop the patch once a release includes it. |

Tests: `apps/web/tests/terminal-ws.test.ts` (the serialized replay keeps bold
after dim, OSC 8 links, and an inverse wide-glyph padding cell) and
`apps/web/e2e/terminal-find-search-addon.spec.ts` (a line wrapped across 8,000
rows, and whole word). The zero-count cursor move has no test: it needs a
wrapped row made only of empty cells ahead of a specific next-row glyph, and no
shell output reaches it reliably.

## Layout

- `xterm-src/*.src.patch` holds the source changes (`src/*.ts`). These are the
  files you edit.
- `@xterm__*.patch` is what pnpm applies: the same source hunks plus the rebuilt
  `lib/` bundles and sourcemaps. It is generated. Never edit it by hand, and
  never run `pnpm patch-commit` on it.
- `xterm-upstream.json` pins the upstream commit each published package was
  built from (`d3e32b3`, which the tarball's `package.json` names in `commit`)
  and the toolchain its `package-lock.json` resolves.
- `scripts/xterm-patches/` holds the generator, vendored from orca (MIT).

## Regenerating

The generator clones xterm.js at the pinned commit, installs its toolchain,
checks that a clean build reproduces the published `lib/` byte for byte, then
applies the source patch, rebuilds, and diffs against the published tarball. A
cold run takes a few minutes, most of it `npm ci`.

```sh
# 1. Edit the source patch. For anything bigger than a line, edit the checkout
#    the generator leaves behind and re-diff it (run --check once to create it):
node scripts/xterm-patches/regenerate.mjs --check --work-dir=/tmp/xterm
$EDITOR /tmp/xterm/upstream/addons/addon-search/src/SearchEngine.ts
git -C /tmp/xterm/upstream/addons/addon-search diff --relative -- src/ \
  > patches/xterm-src/@xterm__addon-search@0.17.0-beta.300.src.patch

# 2. Rebuild the full patch and update the hash in pnpm-lock.yaml.
node scripts/xterm-patches/regenerate.mjs --write --work-dir=/tmp/xterm

# 3. Reinstall, then confirm the patches and lockfile agree.
npx pnpm@10 install --lockfile-only && pnpm install
node scripts/xterm-patches/regenerate.mjs --check --work-dir=/tmp/xterm
```

Keep the work dir outside this repository. Inside it, upstream's `tsgo` walks up
into Band's `node_modules` and fails with `TS2300: Duplicate identifier`.

### Lockfile

Update `pnpm-lock.yaml` with pnpm 10, which CI pins:
`npx pnpm@10 install --lockfile-only`. pnpm 11 writes a `patchedDependencies`
entry as `'<pkg>@<version>': <hash>` on one line, and pnpm 10 then fails
`--frozen-lockfile` with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`; it only reads the
two-line shape:

```yaml
patchedDependencies:
  '@xterm/addon-search@0.17.0-beta.300':
    hash: <sha256 of the patch file>
    path: patches/@xterm__addon-search@0.17.0-beta.300.patch
```

pnpm 11 also re-resolves unrelated peers (for example `@anthropic-ai/sdk`)
when it rewrites the lockfile, which pnpm 10 leaves alone. pnpm 11 reads the
two-line shape, so a local `pnpm install` with either version works afterwards.
`--check` accepts both shapes.

## Bumping xterm.js

Upstream publishes each package only when its own output changes, so packages
built from one commit carry different beta numbers. Match them by the `commit`
field in each tarball's `package.json` (`npm view @xterm/addon-search@<v>
commit`), not by the version string. Keep every `@xterm/*` package in
`apps/web/package.json` on the same commit.

1. Bump the versions in `apps/web/package.json`.
2. Rename both files of each patch, and update `version`, `sourcePatch` and
   `patch` in `xterm-upstream.json` and the keys in `pnpm-workspace.yaml`.
3. Set `upstream.commit` to the new commit and `toolchain` to what its
   `package-lock.json` resolves.
4. Run `--write`. A `git apply` failure here is a real conflict with upstream:
   resolve it in the checkout and re-diff. `--write` leaves a new package out of
   the lockfile and tells you to install.
5. `npx pnpm@10 install --lockfile-only`, `pnpm install`, then `--check`.

When a release includes a fix, delete its patch files and its entries in
`xterm-upstream.json` and `pnpm-workspace.yaml`.

## Not ported from orca

- `@xterm/xterm`: IME composition hooks. A rewrite of `CompositionHelper` that
  raises `xterm-composition-*` events for orca's renderer to consume. Band has
  no consumer and no open IME bug.
- `@xterm/xterm`: `SortedList` deletes decorations by identity. A scrollback
  trim sets a marker's line to -1 before removing its decoration, which makes
  the delete O(k) per decoration. Band's only decorations are search
  highlights, capped at 1,000, so the trim costs milliseconds. Not worth a
  7 MB patch.
- `@xterm/addon-webgl`: `clearTexture` stops clearing once a merged page sits
  at index 0. Only the public `clearTextureAtlas()` reaches it, and Band stopped
  calling that in #637; it rebuilds the addon instead. The patch also adds a
  shader fallback for a texture page past the sampler budget, which upstream
  #6043 (already in Band's versions) prevents, a merge-retry fix that only
  matters after 32 atlas merges in one frame, and an orca-only font diagnostic.
  Not worth a 3.6 MB patch.
- `@xterm/addon-ligatures`: Band does not use the addon.
- `node-pty@1.1.0`: most of orca's patch is native (close-on-exec on the PTY
  master, detailed `posix_spawn` errors, glibc symbol pins for Ubuntu 20.04,
  ConPTY cleanup). Band installs node-pty's macOS and Windows prebuilds, so a
  patch to `src/*.cc` is never compiled there. The JavaScript half (pace the
  `EAGAIN` write retry with a 1 ms timer instead of `setImmediate`, and retire
  the master fd when the PTY exits) would apply and does touch the terminal
  daemon. It belongs in its own change with a daemon-level test.
