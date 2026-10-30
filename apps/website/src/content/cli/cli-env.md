---
title: band env
description: Check a repo's .band/environment.json and build or inspect its environment image.
section: cli
order: 100
commands: [env]
---

`band env` works with a repo's `.band/environment.json`. The file format, and how images are built and cached, are in [Agent environments](agent-environments.md).

## Concepts

`validate` reads the file on the machine where you run it, through the hub. `build` and `status` take a repo name from `band repos list`. A build uses the repo's default branch, and Band caches the image by a key computed from the environment files, so an unchanged repo is a cache hit.

## Output

`validate` takes a directory or the file itself, and defaults to the current directory. When the file is valid it prints `OK <path>` and exits with 0. Otherwise it exits with 1 and prints each problem with its key path:

```text
.band/environment.json has 1 problem:
  build.dockerfile: file does not exist
```

When no file exists it prints `No .band/environment.json found in <dir>`.

`build` starts a build, streams its log, and prints a final line such as `ready <image> (key <12 characters>)`. A cache hit prints `Cache hit: ...` and returns at once. `--force` builds again anyway. `--no-wait` returns after the build starts. The command exits with 1 if the build fails.

`status` prints `Current image:` (or that no build has finished), then `Latest build:` with the log.

## Examples

```sh
band env validate
band env validate ../other-repo
band env build my-app
band env build my-app --force --no-wait
band env status my-app
```
