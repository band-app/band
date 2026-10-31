---
title: band simulators
description: Open a worktree's iOS simulator as a tab in Band.
section: cli
order: 125
commands: [simulators]
---

`band simulators open` boots a worktree's iOS simulator and opens its Simulator tab for every connected Band client. The tab is view-only until a person takes control. For the tab itself and the agent tools, see the simulator guide in the repository (`docs/simulator.md`).

## Concepts

The worktree's worker must be a Mac with Xcode. A worker without the `simulator` capability answers with an error that names the worker. An agent running on a worker gets 403 from this command and drives the simulator with the `simulator_*` tools instead.

## Examples

```sh
band simulators open
band simulators open my-repo-feature
```
