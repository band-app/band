#!/bin/sh
# Regenerates src/data/cli-schema.json from the CLI's own clap definitions.
# Run it after a change to apps/cli/src/main.rs; a test fails when the file is stale.
set -eu
cd "$(dirname "$0")/../../.."
cargo build --manifest-path apps/cli/Cargo.toml --quiet
apps/cli/target/debug/band schema > apps/website/src/data/cli-schema.json
