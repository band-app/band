---
title: band settings and version
description: Print the hub's settings, the CLI and hub versions, and point the CLI at a hub.
section: cli
order: 125
commands: [settings, version]
---

`band settings` prints the hub's current settings. `band version` prints the CLI version and the hub version. Neither takes arguments. For the settings themselves, see [Configuration](configuration.md).

## How the CLI finds the hub

Every command that talks to the hub finds it the same way:

- The URL is `$BAND_SERVER_URL` when set. Otherwise it is `http://127.0.0.1:<port>`, where the port is `webServerPort` in `~/.band/settings.json`, or 3456 when that key is missing.
- The token is `$BAND_TOKEN` when set. Otherwise it is `tokenSecret` from `~/.band/settings.json`.
- `$BAND_HOME` replaces `~/.band` as the folder that holds `settings.json`.

Agents that Band starts get `BAND_SERVER_URL` and `BAND_TOKEN`, so the CLI works inside a chat or terminal with no setup. Point it at a remote hub from your own machine like this:

```text
BAND_SERVER_URL=https://hub.example.com BAND_TOKEN=<token> band version
```

## Output formats

Every command accepts `--output json`, or `BAND_OUTPUT=json` in the environment. JSON goes to stdout. Errors go to stderr, as `error: <message>` in text mode and as `{"error": "<message>"}` in JSON mode, and the exit code is 1.

## Output

`settings` prints the hub's settings as indented JSON. With `--output json` it prints the same data on one line.

`version` prints two lines. If the hub does not answer, the second line says `unreachable`, and the command still succeeds.

```text
CLI: 0.1.0
Hub: 0.1.0
```

## Examples

```sh
band version
band settings
band settings --output json
```
