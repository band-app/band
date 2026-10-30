---
title: Remote access
description: Reach your hub from a phone or another computer with a Tailscale address, your own HTTPS domain or a temporary Cloudflare tunnel.
section: access
order: 20
---

The hub listens on port 3456 (`webServerPort` in Settings > Web Server changes it) and accepts connections only with a token. A device needs a route to that port and a [device token](devices.md). This page covers the routes.

The Docker setup in [Run the hub on a server](run-the-hub-on-a-server.md) publishes the port on the server's loopback address only. Set `BAND_BIND` there to open it to other machines.

| Route | Use it when |
| --- | --- |
| Local network | The device and the hub are on the same network. |
| Tailscale | You already use Tailscale and want a private address. |
| Your own HTTPS domain | The hub runs on a server and you want a stable address. |
| Cloudflare tunnel | You want a temporary public URL with no setup on the network. |

Whichever route you pick, a client signs in with a token. Without a valid token the hub answers 401.

## Local network

Open `http://<hub machine address>:3456` on the other device. The Connect dialog in Settings > Devices lists the hub machine's network addresses. Pick one and scan the code. See [Devices and pairing](devices.md#choose-the-address).

The [iOS app](ios-app.md) may use plain `http` for private addresses on the local network. For everything else it needs `https`.

## Tailscale

Install Tailscale on the hub's machine and on the device. The Connect dialog lists the hub's Tailscale address first, in the `100.64.0.0/10` range. The iOS app accepts plain `http` to that range.

Plain `http` carries the token and pairing code in clear text over the Tailscale link. Tailscale encrypts that link, but to use a proper certificate and a name, run `tailscale serve` on the hub's machine to give it an `https://<machine>.<tailnet>.ts.net` address. Then add that URL as a custom address in the Connect dialog, or set it as `BAND_PUBLIC_URL`.

## Your own domain with HTTPS

For a hub on a server, put HTTPS in front of it. The [server guide](run-the-hub-on-a-server.md#https) covers the bundled Caddy setup and the settings for any other reverse proxy. The proxy must pass WebSocket upgrades, because chats, terminals and status updates use them.

Set `BAND_PUBLIC_URL` on the hub to the public address, for example `https://band.example.com`. The Connect dialog then offers it first. If a browser UI is hosted at another origin, list that origin in `BAND_ALLOWED_ORIGINS`.

## Cloudflare tunnel

The tunnel gives the hub a temporary `https://...trycloudflare.com` address through Cloudflare's free quick tunnel. You need no Cloudflare account and no open port. Use it to try Band on a phone, not as a permanent address, because the URL changes each time the tunnel starts.

The tunnel needs the `cloudflared` program on the hub's machine. On macOS, Band offers to install it with Homebrew the first time. Elsewhere, install it with your package manager first.

To start it, open the More actions menu (the three dots) in the footer of the sidebar and choose Start tunnel. Band shows a Mobile Access dialog with a QR code and the address. While it runs, the menu item reads Mobile access, and Stop Tunnel in that dialog ends it.

From the command line:

```sh
band tunnel start
band tunnel status
band tunnel stop
```

**The QR code and the URL the tunnel prints carry the hub's shared admin token** in a `?token=` parameter. Anyone who holds that URL is signed in as an admin. Do not post it. Stop the tunnel when you are done. For a phone you plan to keep using, add it as a device instead, so you can revoke it later.

Stopping the tunnel ends the public URL at once.

## Connect the iOS app

1. In Settings > Devices, create a device and choose an address the phone can reach (see the routes above).
2. In the app, scan the QR code on the Connect dialog, or open the link on the phone.
3. Confirm Connect. The app trades the one-time code for its own token.

Details are in the [iOS app guide](ios-app.md).

## Connect a browser or the CLI

A browser signs in through the pairing link. A script uses `BAND_SERVER_URL` and `BAND_TOKEN`:

```sh
export BAND_SERVER_URL=https://band.example.com
export BAND_TOKEN=<token>
band repos list
```

The desktop app connects to a remote hub in Settings > Hub.

## Security notes

- Prefer a device token per device over the shared token. You can revoke a device without changing anything else.
- Use HTTPS for any address outside your own network or Tailscale. The token travels with every request.
- A pairing link works once and expires after 15 minutes, but treat it like a password until it is used.
- If a token leaks, revoke the device in Settings > Devices. To replace the shared token, change `tokenSecret` in `~/.band/settings.json` and restart the hub, or set `BAND_ADMIN_TOKEN` on a Docker hub.
- Agents do not get hub tokens. A worker's agents reach the hub through a relay that limits them to their own worktree.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `BAND_PUBLIC_URL` | The hub's public address. The Connect dialog offers it first, and the GitHub webhook uses it. |
| `BAND_ALLOWED_ORIGINS` | Extra origins allowed by CORS and the WebSocket origin check. |
| `BAND_ADMIN_TOKEN` | Sets the shared admin token. |
| `BAND_PAIRING_TTL_MS` | Life of a pairing code in milliseconds. Default 15 minutes. |
