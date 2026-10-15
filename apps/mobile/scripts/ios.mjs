/**
 * The iOS side of mobile-verify: build the app for the simulator and pick the simulator.
 * DerivedData stays in `build/DerivedData` inside the worktree, so deleting the worktree frees it.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLE_ID = "app.getband.mobile";
const DERIVED_DATA = join(APP_ROOT, "build/DerivedData");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: APP_ROOT, stdio: "inherit", ...opts });
}

export function appPath(configuration = "Release") {
  return join(DERIVED_DATA, `Build/Products/${configuration}-iphonesimulator/Band.app`);
}

/**
 * `expo prebuild` (when `ios/` is missing), `pod install`, then `xcodebuild` for the simulator.
 * Release embeds the JS bundle, so the app runs without Metro. `env` reaches the bundler, which
 * inlines `EXPO_PUBLIC_*` variables into the bundle.
 */
export function buildForSimulator(configuration = "Release", env = {}) {
  if (!existsSync(join(APP_ROOT, "ios/Band.xcworkspace"))) {
    run(join(APP_ROOT, "node_modules/.bin/expo"), ["prebuild", "--platform", "ios", "--no-install"]);
    run("pod", ["install"], { cwd: join(APP_ROOT, "ios") });
  }
  const args = [
    "-workspace",
    "ios/Band.xcworkspace",
    "-scheme",
    "Band",
    "-configuration",
    configuration,
    "-sdk",
    "iphonesimulator",
    "-destination",
    "generic/platform=iOS Simulator",
    "-derivedDataPath",
    DERIVED_DATA,
    // Ad-hoc "Sign to Run Locally": no team needed, and the signature carries the
    // entitlements the Keychain (expo-secure-store) requires. Unsigned builds fail every
    // Keychain call with "A required entitlement isn't present".
    "CODE_SIGN_IDENTITY=-",
  ];
  // One architecture is enough for the local simulator and halves the build.
  if (arch() === "arm64") args.push("EXCLUDED_ARCHS=x86_64");
  run("xcodebuild", [...args, "build"], { env: { ...process.env, ...env } });
  return appPath(configuration);
}

function simctlJson(...args) {
  return JSON.parse(execFileSync("xcrun", ["simctl", ...args, "-j"], { encoding: "utf8" }));
}

/**
 * The simulator to use: `BAND_SIM_UDID`, else a booted iPhone, else an existing iPhone on the
 * newest iOS runtime, which gets booted. Never creates a simulator.
 */
export function pickSimulator() {
  const { devices } = simctlJson("list", "devices", "available");
  const runtimes = Object.keys(devices)
    .filter((r) => r.includes("iOS"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const wanted = process.env.BAND_SIM_UDID;
  // A simulator picked by UDID may have a custom name; otherwise only iPhones qualify.
  const phones = runtimes.flatMap((r) =>
    devices[r].filter((d) => (wanted ? d.udid === wanted : d.name.startsWith("iPhone"))),
  );
  const device = wanted
    ? phones.find((d) => d.udid === wanted)
    : (phones.find((d) => d.state === "Booted") ?? phones[0]);
  if (!device) throw new Error("No iPhone simulator found. Install an iOS runtime in Xcode.");
  if (device.state !== "Booted") {
    console.log(`Booting ${device.name} (${device.udid})`);
    execFileSync("xcrun", ["simctl", "boot", device.udid], { stdio: "inherit" });
  }
  execFileSync("xcrun", ["simctl", "bootstatus", device.udid, "-b"], { stdio: "ignore" });
  return device;
}

export function installApp(udid, app) {
  run("xcrun", ["simctl", "install", udid, app]);
}
