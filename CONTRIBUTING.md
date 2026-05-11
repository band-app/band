# Contributing to Band

Thanks for your interest in contributing to Band! This guide will help you get started.

## Getting Started

### 1. Fork the Repository

Click the **Fork** button on the [GitHub repo](https://github.com/band-app/band) to create your own copy.

### 2. Clone Your Fork

```bash
git clone https://github.com/<your-username>/band.git
cd band
```

### 3. Add the Upstream Remote

```bash
git remote add upstream https://github.com/band-app/band.git
```

### 4. Install Dependencies

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Node.js dependencies
pnpm install
```

See the [README](README.md) for full prerequisites (Node.js 22.5+, pnpm 10+, Rust).

## Making Changes

### 1. Create a Branch

Always branch off the latest `main`:

```bash
git fetch upstream
git checkout -b my-feature upstream/main
```

### 2. Make Your Changes

Follow the existing code style — the project uses [Biome](https://biomejs.dev/) for JS/TS and `cargo fmt` / `cargo clippy` for Rust.

### 3. Run Checks Locally

Before pushing, make sure everything passes:

```bash
# Lint
pnpm check

# Test
pnpm test
```

### 4. Commit

Write clear, concise commit messages. Use imperative mood:

```
Add workspace search shortcut
Fix LSP timeout on large monorepos
Update dashboard panel layout
```

### 5. Push and Open a PR

```bash
git push origin my-feature
```

Then open a Pull Request against `band-app/band:main` from your fork.

## Pull Request Guidelines

- **Keep PRs focused.** One logical change per PR. If you have multiple unrelated fixes, open separate PRs.
- **Describe what and why.** The PR description should explain the change and the motivation. Link any related issues.
- **Include a test plan.** Describe how to verify the change works — steps to reproduce, expected behavior, screenshots if relevant.
- **Don't include unrelated changes.** Avoid reformatting files you didn't modify or adding unrelated fixes.

## CI on Pull Requests

CI does not run automatically on fork PRs to keep costs under control. Here's how it works:

1. You open a PR from your fork.
2. A maintainer reviews the code.
3. The maintainer adds the `ci:approved` label to trigger CI.
4. CI runs. If you push new commits, CI re-runs automatically while the label is present.

## Automated Claude Reviews

PRs opened by project collaborators (OWNER / MEMBER / COLLABORATOR on this repo) automatically receive an AI review from Anthropic's Claude via [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) — see [`.github/workflows/claude-review.yml`](.github/workflows/claude-review.yml). The review posts inline comments on findings plus a single top-level summary; it's advisory, not a required check, and a human reviewer is still expected to sign off. PRs from outside contributors / forks intentionally do **not** trigger the automated review (budget and noise control), and `pull_request` (rather than `pull_request_target`) is used so the `CLAUDE_CODE_OAUTH_TOKEN` secret is never exposed to fork code.

## What to Contribute

- **Bug fixes** — check [open issues](https://github.com/band-app/band/issues) or report a new one.
- **Features** — open an issue first to discuss the approach before investing time in a large PR.
- **Documentation** — improvements to README, CONTRIBUTING, or code comments are always welcome.
- **Tests** — we use integration tests (see below). Adding test coverage is a great way to contribute.

## Testing

This project uses **integration tests** as the primary testing approach. Do not write unit tests with mocked dependencies.

- **Black-box testing only.** Test through public interfaces: HTTP endpoints, CLI commands, file system outputs.
- **Real infrastructure.** Use test containers for databases, temporary directories for file-based state, real servers on random ports.
- **MSW for external APIs.** Mock only third-party APIs you don't own, using [MSW](https://mswjs.io/) at the network layer.
- **Node.js built-in test runner.** Use `node:test` with `node:assert/strict`.
- **Never modify production code to make a test pass.**

## Building Locally vs. Signed Releases

Local builds (`pnpm build:desktop`) produce **unsigned** `.dmg` artifacts. macOS Gatekeeper will warn that the app is "damaged" or "from an unidentified developer" on first launch — this is expected for fork builds.

Signed + notarized releases are produced **only** by the official `release.yml` and `nightly.yml` GitHub Actions workflows running on `band-app/band`. Apple Developer certificates and App Store Connect API keys live in a protected `production` GitHub Environment with required reviewers and `main`-branch restrictions, so:

- Forks cannot trigger signed builds (secrets are not exposed to fork PRs).
- Pull requests cannot exfiltrate signing credentials — release workflows only run via `workflow_dispatch` from maintainers.

If you need to test a fork build on your own Mac, either:

1. Right-click the `.app` → **Open** → confirm once, **or**
2. `xattr -dr com.apple.quarantine /path/to/Band.app` to clear the quarantine flag.

Do not request signing access for a fork — sign your build with your own Developer ID if you need notarization.

## Code of Conduct

Be respectful and constructive. We're all here to build something useful.

## Questions?

Open an issue or start a discussion on the repo. We're happy to help you get oriented.
