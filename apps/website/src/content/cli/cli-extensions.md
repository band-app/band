---
title: band extensions
description: List the editor extensions installed on the hub and reread them after copying one in.
section: cli
order: 116
commands: [extensions]
---

`band extensions` shows the editor extensions the hub has loaded from `<BAND_HOME>/extensions/<id>/`. An extension adds an editor for some kinds of files, and the web app opens a matching file in it. See [Editor extensions](extensions.md) for the folder layout, the manifest and the editor protocol.

## Concepts

The hub reads the extensions folder at boot. `reload` reads it again, so a folder you just copied in appears without a restart. `install` and `remove` change the folder for you. `install` takes an https URL (or http on loopback) or a local `.tar.gz` file. A local file is uploaded to the hub, so it works against a remote hub. With `--sha256` the hub checks the archive against that hash. Without it the hub checks `<url>.sha256` when that file exists. The old version stays until the new one is valid. `install --official <id>` installs an extension from the official catalog (the `index.json` of `band-app/band-extensions`, checked against its sha256), and `catalog` lists that catalog with what is installed and which entries have an update. `reload`, `install` and `remove` need an admin token, and `list` and `catalog` work with any device token.

A folder whose manifest has an unknown key, a bad selector or an id that differs from the folder name is skipped and logged. `list` and `reload` print it as an `error:` line with the folder and the reason.

## Output

Both commands print the columns ID, NAME, VERSION and EDITORS (each editor's label with its selectors), then one `error: <folder>: <reason>` line per folder that failed to load. With `--output json` they print `{"extensions": [...], "errors": [{"folder": "...", "error": "..."}]}`.

## Examples

```sh
band extensions list
band extensions reload
band extensions install https://example.com/sheet-1.0.0.tar.gz
band extensions install ./sheet-1.0.0.tar.gz --sha256 <hex>
band extensions catalog
band extensions install --official sheet
band extensions remove sheet
```
