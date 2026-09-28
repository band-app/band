#!/usr/bin/env node

// Generates the Homebrew cask definition for the Band desktop app and
// prints it to stdout. The release workflow runs this after building the
// signed DMGs, redirects the output into a clone of band-app/homebrew-band
// (Casks/band.rb), and pushes — keeping the tap in lockstep with every
// release without a manual bump.
//
// Usage:
//   node scripts/generate-homebrew-cask.mjs \
//     --version 0.26.0 \
//     --arm-sha <sha256 of Band-<v>-apple-silicon.dmg> \
//     --intel-sha <sha256 of Band-<v>-intel.dmg>

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { version: null, armSha: null, intelSha: null };

  // Read the value that follows a flag, failing with a flag-specific message
  // if it was the last token (so an omitted value isn't misreported later as
  // a malformed one).
  const takeValue = (flag, i) => {
    if (i >= args.length) {
      console.error(`${flag} requires a value`);
      process.exit(1);
    }
    return args[i];
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--version":
        opts.version = takeValue("--version", ++i);
        break;
      case "--arm-sha":
        opts.armSha = takeValue("--arm-sha", ++i);
        break;
      case "--intel-sha":
        opts.intelSha = takeValue("--intel-sha", ++i);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!/^\d+\.\d+\.\d+$/.test(opts.version ?? "")) {
    console.error("--version must be a semver like 0.26.0");
    process.exit(1);
  }
  for (const [flag, value] of [
    ["--arm-sha", opts.armSha],
    ["--intel-sha", opts.intelSha],
  ]) {
    if (!/^[0-9a-f]{64}$/.test(value ?? "")) {
      console.error(`${flag} must be a lowercase hex sha256`);
      process.exit(1);
    }
  }

  return opts;
}

const { version, armSha, intelSha } = parseArgs();

// The `binary` stanza symlinks the CLI sidecar bundled inside the app
// (placed in Contents/Resources/binaries/ by electron-builder's
// extraResources config) into Homebrew's bin, so `brew install --cask band`
// also provides the `band` command without the in-app admin-privileged
// symlink flow.
process.stdout.write(`cask "band" do
  version "${version}"

  on_arm do
    sha256 "${armSha}"

    url "https://github.com/band-app/band/releases/download/v#{version}/Band-#{version}-apple-silicon.dmg"
  end
  on_intel do
    sha256 "${intelSha}"

    url "https://github.com/band-app/band/releases/download/v#{version}/Band-#{version}-intel.dmg"
  end

  name "Band"
  desc "IDE-agnostic agent orchestrator"
  homepage "https://github.com/band-app/band"

  # Band ships a Squirrel.Mac auto-updater (see the ShipIt entry in the zap
  # trash list below), so the app upgrades itself in place. auto_updates true
  # tells Homebrew not to manage upgrades -- hence no livecheck block, which
  # would only matter if brew upgrade owned the upgrade path.
  auto_updates true
  depends_on macos: :big_sur

  app "Band.app"
  binary "#{appdir}/Band.app/Contents/Resources/binaries/band"

  zap trash: [
    "~/.band",
    "~/Library/Application Support/Band",
    "~/Library/Caches/app.getband.agent",
    "~/Library/Caches/app.getband.agent.ShipIt",
    "~/Library/Logs/Band",
    "~/Library/Preferences/app.getband.agent.plist",
    "~/Library/Saved Application State/app.getband.agent.savedState",
  ]
end
`);
