---
title: iOS app
description: Follow your worktrees, talk to agents, read files and check pull requests from an iPhone connected to your hub.
section: mobile
order: 10
---

The Band iOS app is a client for your hub. It does not run agents or hold your code. It shows what the hub knows and sends your input back, so anything you start on the phone runs on a worker.

## What it does

- Home. Lists your repos and worktrees as the web sidebar does, with pinned worktrees first, the agent state, the pull request and its CI state. You can search, filter by group, pin, rename, set a parent, move into or out of a group, mark read or unread, and delete. A banner says Reconnecting when the hub is out of reach.
- Start an agent. The composer at the bottom of Home starts a chat in a new worktree. New worktree creates one without a prompt.
- Chat. Shows the agent's transcript, tool calls, plans and queued messages. It answers permission and question requests from the agent. You can attach a photo, take one, or choose a file. Tabs for a worktree's chats and terminals are shared with the web UI, so a tab opened on your laptop shows up on the phone.
- Terminal. Opens a worktree's terminal tab, with a key bar for keys a touch keyboard lacks. Scrollback holds 10,000 lines.
- Files. Browses the worktree, previews files and video, and shows the changes and the diff of each file.
- Checks. Shows the worktree's pull request: its checks, reviewers and discussion. You can re-run checks and merge when the pull request is ready.
- Voice. The composer's mic dictates text. See [Voice dictation](voice-dictation.md).
- Settings. Lists workers (and updates one, with an admin token), the coding agents and their models, account usage, voice, devices and an About screen with the hub and app versions. You can add a device from the phone with an admin token.

The look follows the system light or dark appearance. You can pair more than one hub and switch between them.

The app is iOS only.

## Get the app

Band's releases submit the iOS app to TestFlight. There is no public invitation link yet, so you need an invite from the Band team, or you can build the app yourself from the repository.

To build it yourself, you need a Mac with Xcode, CocoaPods, Node 24 and pnpm. In the repo's `apps/mobile` folder, run `npx expo prebuild --platform ios --no-install`, open `ios/Band.xcworkspace` in Xcode, choose your team, change the bundle identifier to one your team owns, and run it on the phone. The README in `apps/mobile` lists every step.

## Requirements

- A hub the phone can reach. See [Remote access](remote-access.md) for the routes.
- `https` for any hub outside your network. The app refuses plain `http` unless the address is local: a private address (`10.x`, `172.16-31.x`, `192.168.x`), a link-local or `.local` name, or a Tailscale address in `100.64.0.0/10`. Plain `http` sends the token in clear text, so use it only on a network you trust.
- On the first connection to a local-network hub, accept the iOS prompt that lets Band find devices on your network.
- An admin device for the Devices, Workers update and Voice setup screens. Other screens work with a standard device.

## Pair with a hub

1. On your computer, open Settings > Devices and click Add device. Name it, for example "iPhone", and click Create device. See [Devices and pairing](devices.md).
2. In the Address list, choose an address the phone can reach.
3. On the phone, open Band and tap Scan QR code. Allow the camera. Scan the code on your screen.
4. Tap Connect on the "Connect to this hub?" screen.

If you cannot scan, tap Enter URL and token. Enter the hub URL and a device token from `band tokens create-device`. You can also open the connect link on the phone. It starts the app through a `band://pair` link.

The QR code holds a one-time pairing code, not your token. The app sends it to the hub, which answers with a new token for this device. The code works once and expires after 15 minutes. If the app says the link was already used or has expired, open Connect details for the device and scan the new code, or press Regenerate.

The app stores the token in the iOS Keychain. To remove a hub, use Switch or sign out in Settings > About, or revoke the device in Settings > Devices on your computer. A revoked device is signed out at once.
