# iOS simulator

Band no longer bundles a simulator. The iOS simulator is the official `simulator` extension in [band-app/band-extensions](https://github.com/band-app/band-extensions) (`extensions/simulator`). Install it from Settings > Extensions, or with `band extensions install --official simulator`. It needs a Mac worker with Xcode, and its `minBand` in the catalog names the first Band release that has the pieces it relies on.

What Band provides for it:

- A worker service and panel mechanism (`docs/extensions.md`): the extension's service runs on each eligible Mac worker and reports the `simulator` capability.
- A direct stream path for panels, so the desktop app gets full-size frames from this Mac's own worker. The service sees `profile: "direct"` there and `profile: "hub"` through the hub (`docs/extensions.md`, Panels, and `docs/local-direct-path.md`).
- Image results for agent tools, which is how `simulator_screenshot` returns a picture (`docs/extensions.md`, Tools).

The device naming, the booted-device cap, the serve-sim pin and the `BAND_SIMULATOR_*` settings belong to the extension now. Its README documents them.
