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

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--version":
        opts.version = args[++i];
        break;
      case "--arm-sha":
        opts.armSha = args[++i];
        break;
      case "--intel-sha":
        opts.intelSha = args[++i];
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
// (electron-builder `extraResources`, see apps/desktop/electron-builder.yml)
// into Homebrew's bin, so `brew install --cask band` also provides the
// `band` command without the in-app admin-privileged symlink flow.
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

  livecheck do
    url :url
    strategy :github_latest
  end

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
