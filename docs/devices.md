---
title: Devices and pairing
description: Sign phones, tablets, browsers and scripts in to your hub with revocable device tokens and one-time pairing links.
section: access
order: 10
---

Every client that talks to your hub, such as a browser, the iOS app, the desktop app or a script, signs in with a token. Band keeps one token per device, so you can revoke a lost phone without touching anything else. You manage them in Settings > Devices.

![Settings > Devices](/docs/screenshots/settings-devices.png)

## Token kinds

- A device token (`bdt_...`) belongs to one device. It has a label and an admin flag. You can revoke it at any time.
- The shared token is a device token with the id `shared`. The hub keeps it in `~/.band/settings.json` as `tokenSecret` and re-reads it at every start. The desktop app and the `band` CLI on the hub's machine use it. It is always an admin token, and Settings > Devices does not let you revoke it.
- A pairing code (`bdp_...`) is not a token. It is a one-time code that a device trades for its own device token.

On a hub started from the [Docker image](run-the-hub-on-a-server.md), `BAND_ADMIN_TOKEN` sets the shared token.

Worker tokens are separate. They only let a worker connect, and a device token cannot act as a worker. See [Adding workers](adding-workers.md).

## Admin and standard devices

A standard device can use the hub: open worktrees, run chats and terminals, and read the worker list. An admin device can also manage the hub itself: devices, workers, credentials, MCP servers, agent logins and the other admin settings. These screens show "needs an admin token" to a standard device.

Create a device as admin only if you trust it as much as the hub's own machine. Agents never receive a device token. They get narrower tokens that cover one worktree.

## Add a device

1. Open Settings > Devices and click Add device.
2. Enter a label, for example "Phone". Turn on Admin device only if the device needs to manage the hub.
3. Click Create device. The Connect dialog opens with a QR code and a link.
4. Scan the code with the phone camera, or open the link in the browser you want to sign in.

The link works once and expires after 15 minutes. Opening it signs the device in and gives it a new token. If a code expires while the dialog is open, Band replaces it. Regenerate makes a new code at once.

A device that has not used its link yet appears in the list with its label. To show the link again, click Connect details on its row. The same code stays valid until it expires or you regenerate it.

The [iOS app](ios-app.md) reads the same QR code. In a browser, the link opens the dashboard already signed in.

## Choose the address

The link has to name an address the device can reach. The Address list in the Connect dialog offers:

- The public URL, when you set `BAND_PUBLIC_URL` on the hub. It is the default.
- The address of the page you are looking at.
- The hub machine's network interfaces, ordered Tailscale first, then IPv4, then IPv6. Docker bridges and other virtual networks come last and are never preselected. Loopback and link-local addresses are left out.
- Addresses you added yourself.

The refresh button next to the list reads the interfaces again. Choose Add custom address... to type a full URL, for example `https://band.example.ts.net`, and Save address. Band checks only that it is an http or https URL. It does not try to reach it. Remove this address deletes a custom one. Band remembers your choice in the browser.

If you pick a loopback address such as `http://localhost:3456`, the dialog warns you. A phone cannot reach it.

A hub in a container sees only container addresses. Set `BAND_PUBLIC_URL` there. See [Remote access](remote-access.md) for the choices of address and HTTPS.

## Revoke a device

Click Revoke on the device's row and confirm. The hub deletes the token and closes any connection that used it, so the device is signed out at once. Revoking the token you are signed in with signs you out of this browser, and the dialog says so.

Server-sent event streams are not tracked, so an open stream can stay up until the client reconnects. The next request fails.

## From the command line

The `band tokens` commands need an admin token.

```sh
band tokens list
band tokens create-device --label "CI script" --admin
band tokens revoke <id>
```

`create-device` prints the token once. Store it somewhere safe, because the hub keeps only a hash. A device made this way has no pairing link. Give the token to the script or client directly.

To use a token from another machine, set the hub address and the token:

```sh
export BAND_SERVER_URL=https://band.example.com
export BAND_TOKEN=<token>
band repos list
```

See [band tokens](/docs/cli-tokens) for every flag.

## Details

- The hub stores only a SHA-256 of each token and pairing code, and no log line holds one.
- The pending code is kept encrypted so that Connect details can show the same link again. The hub clears it when a device uses it.
- A wrong, used, expired or revoked code gets one generic 401 answer.
- `BAND_PAIRING_TTL_MS` changes the 15 minute life of a code.
- The older `?token=<token>` sign-in link still works, and the app accepts it.
