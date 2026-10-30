---
title: band tokens
description: List, create and revoke the hub's device tokens.
section: cli
order: 105
commands: [tokens]
---

`band tokens` manages the tokens that let devices and scripts use the hub. Every `band tokens` command needs an admin token and answers 403 otherwise. For the UI side, see [Devices](devices.md).

## Concepts

A device token is for a UI or a script. By default it cannot manage tokens. Create it with `--admin` when it should. The hub's shared token, which the desktop app and the CLI read from `settings.json`, is an admin token and cannot be revoked. Worker tokens appear in the list too, and you can revoke them.

Revoking a token stops it at once and closes the connections it opened.

## Output

`list` prints the columns ID, KIND, LABEL, STATE and LAST USED. It never shows secrets.

`create-device` prints the token id, then `Token: <token>`, then a reminder that this is the only time the token is shown. Copy it right away. `--label` names it in the list (default `CLI device`).

`revoke` prints `Token <id> revoked`.

## Examples

```sh
band tokens list
band tokens create-device --label "CI script"
band tokens create-device --label "Second laptop" --admin
band tokens revoke <id>
```
