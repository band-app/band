---
title: band tunnel
description: Start, stop and check the public tunnel to your hub.
section: cli
order: 120
commands: [tunnel]
---

`band tunnel` controls a public tunnel to the hub, so you can reach Band from a phone or another network. For the other ways to get remote access, see [Remote access](remote-access.md).

## Concepts

The tunnel is a Cloudflare quick tunnel run by `cloudflared`. Install `cloudflared` first, for example with `brew install cloudflared` on macOS. You need no Cloudflare account. Each start gets a random `*.trycloudflare.com` address, and the address changes when the tunnel restarts. Band has no setting for a named or fixed tunnel.

The printed URL ends in `?token=<hub token>`. Anyone with the full URL can sign in to your hub, so treat it as a secret. To give a device its own revocable access instead, use [Devices](devices.md).

Starting a tunnel that is already running returns the existing URL. Settings has an "Auto-start tunnel" switch that starts it when the app launches.

## Output

`status` prints `running: yes` and `url: <url>`, or `running: no`.

```text
running: yes
url: https://some-random-words.trycloudflare.com?token=...
```

`start` prints the URL and nothing else. `stop` prints nothing.

## Examples

```sh
band tunnel start
band tunnel status
band tunnel stop
```
