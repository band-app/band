# macOS Code Signing & Notarization Spec

Spec for signing + notarizing the Band Tauri desktop app (`apps/dashboard`) on GitHub Actions, while preserving auto-updates and remaining open-source friendly.

## Goals

- Distribute signed + notarized `.dmg` and `.app.tar.gz` from GitHub Releases.
- Preserve existing Tauri updater flow (`latest.json` + minisign signature).
- No credentials exposed in logs, PRs, forks, or repo history.
- Community contributors can build unsigned dev artifacts locally without secrets.
- Pre-release dry-run path (no production secrets touched) before tag push.

## Non-Goals

- Windows / Linux signing (separate spec).
- Mac App Store distribution (requires different cert + sandboxing).
- Sparkle integration (Tauri's built-in updater is sufficient).

## Background — current state

Existing `release.yml` produces:
- `*.dmg` (unsigned, "damaged app" warning on Gatekeeper)
- `*.app.tar.gz` + `.sig` (Tauri updater payload, signed via `TAURI_SIGNING_PRIVATE_KEY` minisign — separate from Apple signature)
- `latest.json` manifest pointing at `*.app.tar.gz`

Two signature systems coexist:
1. **Apple Developer ID signature** — Gatekeeper trust, notarization stapling. Applied to `.app` inside `.dmg` and `.app` archived into `.app.tar.gz`.
2. **Tauri updater signature** — minisign over `.app.tar.gz`, verified by client before applying update. Already working. Untouched by this spec.

Both required: Apple signature for first-launch trust, Tauri signature for update authenticity.

## Apple Developer Account Requirements

- Apple Developer Program membership ($99/yr) — required, no free path for notarization.
- **Developer ID Application** certificate (NOT "Apple Development" or "Mac App Distribution"). Generate via Xcode → Settings → Accounts → Manage Certificates, or developer.apple.com.
- **App Store Connect API key** (Users and Access → Integrations → App Store Connect API → Team Keys → "+"). Role: **Developer**. Download `.p8` (one-time download). Capture Key ID + Issuer ID.
  - Preferred over app-specific password: scoped, revocable, no human account dependency.

## Secrets Inventory

Stored in GitHub repo: Settings → Secrets and variables → Actions → **Repository secrets** (or Environment secrets on `production` env).

| Secret | Source | Format |
|---|---|---|
| `APPLE_CERTIFICATE` | `.p12` export of Developer ID Application cert + private key | base64 (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | Password set when exporting `.p12` | plaintext |
| `APPLE_SIGNING_IDENTITY` | Common name of cert | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_TEAM_ID` | developer.apple.com → Membership | 10-char string |
| `APPLE_API_KEY_ID` | App Store Connect API key | 10-char string |
| `APPLE_API_ISSUER` | App Store Connect API key | UUID |
| `APPLE_API_KEY` | `.p8` file from API key generation | base64 of file contents |
| `KEYCHAIN_PASSWORD` | Random ephemeral keychain password | `openssl rand -base64 32` |
| `TAURI_SIGNING_PRIVATE_KEY` | **Already exists** | — |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | **Already exists** | — |

Total new secrets: 8.

## Open-Source Safety Model

GitHub Actions secrets default behavior protects forks:
- Secrets are **not** passed to workflow runs triggered by `pull_request` from forks. Verified by GitHub docs.
- Release workflow uses `workflow_dispatch` only — manually triggered by maintainer with `contents: write`. No PR can invoke it.

Hardening:
1. Move all Apple secrets to a GitHub **Environment** named `production`.
2. Configure environment with **Required reviewers** (maintainers list). Releases prompt for approval before secrets unlock.
3. Restrict environment to `main` branch (Deployment branches → Selected branches: `main`).
4. Add CODEOWNERS for `.github/workflows/release.yml` so changes need maintainer review.
5. Document in CONTRIBUTING.md: forks build unsigned via `pnpm tauri build` locally — no signing path expected.

Rationale: prevents malicious PR that modifies workflow from exfiltrating secrets via `echo`, `curl`, or environment dump.

## Tauri Configuration Changes

### `apps/dashboard/src-tauri/tauri.prod.conf.json`

Add bundle config:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "bundle": {
    "createUpdaterArtifacts": true,
    "macOS": {
      "signingIdentity": "-",
      "hardenedRuntime": true,
      "entitlements": "entitlements.plist"
    }
  },
  "plugins": {
    "updater": {
      "pubkey": "...",
      "endpoints": ["..."]
    }
  }
}
```

`signingIdentity: "-"` is overridden by `APPLE_SIGNING_IDENTITY` env var in CI. Keeps local builds ad-hoc signed (works on dev machine).

### `apps/dashboard/src-tauri/entitlements.plist`

New file. Minimal hardened runtime entitlements:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
</dict>
</plist>
```

Reasoning per entitlement:
- `allow-jit` + `allow-unsigned-executable-memory` — WKWebView / V8 needs JIT.
- `disable-library-validation` — `externalBin` (`binaries/band` CLI) is signed separately; without this, codesign rejects it at runtime.
- `network.client` + `network.server` — Band CLI runs local HTTP server; webview makes outbound calls.

Add no broader entitlements unless needed. Each one widens attack surface and slows notarization checks.

## Workflow Changes — `.github/workflows/release.yml`

### Add environment gate

```yaml
jobs:
  release:
    name: Release
    runs-on: macos-latest
    environment: production   # NEW — requires manual approval
    env:
      NODE_OPTIONS: '--max-old-space-size=4096'
```

### New step: import certificate (before "Build DMG")

```yaml
      - name: Import Apple certificate
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          KEYCHAIN_PASSWORD: ${{ secrets.KEYCHAIN_PASSWORD }}
        run: |
          set -euo pipefail
          CERT_PATH="$RUNNER_TEMP/cert.p12"
          KEYCHAIN_PATH="$RUNNER_TEMP/build.keychain-db"

          echo -n "$APPLE_CERTIFICATE" | base64 --decode -o "$CERT_PATH"

          security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

          security import "$CERT_PATH" \
            -P "$APPLE_CERTIFICATE_PASSWORD" \
            -A -t cert -f pkcs12 \
            -k "$KEYCHAIN_PATH"

          security list-keychain -d user -s "$KEYCHAIN_PATH" $(security list-keychains -d user | tr -d '"')
          security set-key-partition-list -S apple-tool:,apple:,codesign: \
            -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

          rm "$CERT_PATH"
          security find-identity -v -p codesigning "$KEYCHAIN_PATH"
```

### Modify existing "Build DMG" step

```yaml
      - name: Build DMG and updater artifacts
        run: pnpm --filter @band-app/dashboard tauri build --ci --config '{"build":{"beforeBuildCommand":""}}' --config src-tauri/tauri.prod.conf.json
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          # NEW — Apple signing + notarization handled by Tauri
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          APPLE_API_KEY_PATH: ${{ runner.temp }}/api-key.p8
        # Write the .p8 file from base64 secret immediately before build
```

Add an inline pre-step to materialize the `.p8`:

```yaml
      - name: Write App Store Connect API key
        env:
          APPLE_API_KEY_B64: ${{ secrets.APPLE_API_KEY }}
        run: |
          mkdir -p "$RUNNER_TEMP"
          echo -n "$APPLE_API_KEY_B64" | base64 --decode -o "$RUNNER_TEMP/api-key.p8"
          chmod 600 "$RUNNER_TEMP/api-key.p8"
```

Tauri reads `APPLE_API_KEY_PATH` (or `APPLE_API_KEY` filename in `~/.appstoreconnect/private_keys/` — path form is explicit, prefer it). Tauri auto-runs `xcrun notarytool submit --wait` and `xcrun stapler staple` after codesign.

### New step: cleanup (always runs)

```yaml
      - name: Cleanup keychain and key
        if: always()
        run: |
          security delete-keychain "$RUNNER_TEMP/build.keychain-db" || true
          rm -f "$RUNNER_TEMP/api-key.p8"
```

### Order of steps

```
Checkout → Rust → Node → pnpm → caches → install deps
→ Determine version → Verify tag → Bump → Lint → Build CLI → Lint dashboard → Test
→ Build frontend
→ Import Apple certificate                          [NEW]
→ Write App Store Connect API key                   [NEW]
→ Build DMG and updater artifacts (now with Apple env vars)
→ Cleanup keychain and key                          [NEW, always]
→ Generate changelog → tag → manifest → release → publish npm
```

Cleanup before release publish is safe — artifacts already on disk.

## Verification Steps

After CI passes, smoke test on a clean Mac (or fresh user account):

```bash
# Download .dmg from release
# Move .app to /Applications

codesign -dvv /Applications/Band.app
# Expect: Authority=Developer ID Application: ...
# Expect: TeamIdentifier=<your team id>
# Expect: Sealed Resources version=2
# Expect: Notarization ticket stapled (look for "Notarization=Accepted" via spctl)

spctl -a -vvv -t install /Applications/Band.app
# Expect: accepted, source=Notarized Developer ID

xcrun stapler validate /Applications/Band.app
# Expect: The validate action worked!
```

Auto-update verification:
1. Install old version (e.g. `v0.1.0`) on test machine.
2. Release new version via workflow.
3. Open old app — Tauri updater fetches `latest.json`, downloads `.app.tar.gz`, verifies minisign signature, swaps `.app`.
4. Confirm updated `.app` still passes `spctl -a` (Apple signature must survive the swap — Tauri preserves it because the `.app` inside `.app.tar.gz` was signed before tarring).

## Cost & Performance Impact

- macOS GH Actions runner: $0.08/min on private repos. Public repos: free. Band is open-source → free.
- Notarization adds 2–10 min per build (Apple side, varies by load). Tauri uses `--wait` so step blocks until complete.
- Cert + API key setup: ~30 min one-time.
- Total release wall-clock: current ~15 min → projected ~20–25 min.

## Risk Register

| Risk | Mitigation |
|---|---|
| Cert expires (5 yr) | Calendar reminder 60 days before; document renewal in `docs/macos-signing-spec.md` |
| API key revoked / lost | Generate replacement, update `APPLE_API_KEY*` secrets; old releases unaffected |
| Notarization rejected (entitlements regression) | CI fails fast (`--wait`); read log via `xcrun notarytool log <id> --key-id ...` |
| Secret leak via malicious PR | Environment gate + branch restriction + CODEOWNERS on workflow |
| Updater signature drift | `TAURI_SIGNING_PRIVATE_KEY` rotation breaks all clients — never rotate without coordinated app version that ships new pubkey |
| `disable-library-validation` widens attack surface | Required for `externalBin`; alternative is signing CLI binary separately with same identity (more work, deferred) |
| Forked PR triggers signed build | Impossible — release uses `workflow_dispatch` only, no `pull_request` trigger |

## Rollout Plan

1. **Phase 0 — prep** (no CI changes): Generate cert + API key. Test signing locally with `pnpm tauri build` + env vars set on dev machine. Confirm `.app` notarizes via `xcrun notarytool submit`.
2. **Phase 1 — secrets + env**: Add 8 secrets to `production` environment. Configure environment reviewers + branch restriction.
3. **Phase 2 — config**: Land `tauri.prod.conf.json` change + `entitlements.plist`. Verify local build still produces `.app` (ad-hoc signed). Merge.
4. **Phase 3 — workflow**: Land `release.yml` changes. Run dry release with `version: 0.0.0-test1` on a test branch with workflow temporarily allowing it. Confirm signed + notarized `.dmg` produced. Discard test release.
5. **Phase 4 — production cut**: Trigger first signed release. Verify on clean Mac. Announce.
6. **Phase 5 — docs**: Update CONTRIBUTING.md (forks build unsigned). Update README install instructions (no more right-click → Open dance).

## Codemagic Comparison (rejected)

Considered but rejected:
- Codemagic free tier: 500 macOS min/mo. Band release ~25 min × 2/mo ≈ 50 min — fits, but adds vendor.
- Codemagic UI handles certs/profiles automatically. Saves ~50 lines of YAML.
- **Rejection reason**: open-source repo benefits from co-located workflow + secrets in GitHub. Splits trust surface across two providers. Tauri action already abstracts most signing complexity. No meaningful win.

Revisit if: macOS minutes become bottleneck on private fork, or signing failure rate exceeds 1 in 10 builds.

## Open Questions

- Should we sign the bundled `binaries/band` CLI separately (deep signing) and drop `disable-library-validation`? Defer until first audit.
- Should release require git tag instead of `workflow_dispatch`? Current flow creates the tag during the run; switching would invert. Out of scope.
- Pre-release channel (beta endpoint in `latest.json`)? Out of scope; design separately if/when needed.

## References

- Tauri signing: https://v2.tauri.app/distribute/sign/macos/
- Tauri notarization: https://v2.tauri.app/distribute/sign/macos/#notarization
- App Store Connect API: https://developer.apple.com/documentation/appstoreconnectapi
- Hardened runtime entitlements: https://developer.apple.com/documentation/security/hardened_runtime
- GitHub Actions secrets in forks: https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions
