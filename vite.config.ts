import { defineConfig } from "vite-plus";

const hostLocalAllowed = [
  "@band-app/host-local/git/git-client",
  "@band-app/host-local/git/git-refusals",
  "@band-app/host-local/process/path",
  "@band-app/host-local/process/cli-binary",
  "@band-app/host-local/process/install",
  "@band-app/host-local/setup/repo-config",
  "@band-app/host-local/terminals/daemon/daemon-backend",
  "@band-app/host-local/terminals/in-process-backend",
  "@band-app/host-local/terminals/terminal-backend",
  "@band-app/host-local/terminals/title-poller",
];

const hostLocalMessage =
  "Services and API handlers use @band-app/host-local for types only. A machine's git, files and processes go through the Host (ctx.host / hostRegistry). Hub-only helpers are listed in vite.config.ts.";

const fsPaths = [
  {
    name: "node:fs",
    message:
      "Services and API handlers reach a machine through the Host (ctx.host / hostRegistry), not node:fs. Hub-state modules are allowlisted in vite.config.ts.",
  },
  {
    name: "node:fs/promises",
    message:
      "Services and API handlers reach a machine through the Host (ctx.host / hostRegistry), not node:fs/promises. Hub-state modules are allowlisted in vite.config.ts.",
  },
  {
    name: "node:child_process",
    message:
      "Run processes through the Host (host.exec, host.git), not node:child_process. Hub-state modules are allowlisted in vite.config.ts.",
  },
];
const ptyPath = {
  name: "node-pty",
  message:
    "Terminals go through the Host's TerminalBackend; node-pty lives in @band-app/host-local.",
};

const pureGitHelpers = [
  "getRepoInfo",
  "DETACHED_BRANCH_PREFIX",
  "parseGitRemoteUrl",
  "RepoInfo",
  "PullRequestSummary",
];
const pureGitHelpersGh = [...pureGitHelpers, "execGh", "execGhWithInput"];

// Oxlint stops reading a pattern group once another pattern whitelists the path
// (the "!" entries), so a named-import limit on git-client has to live in `paths`
// and not in a second pattern.
function restrictedImports(helpers: string[], paths: unknown[]) {
  return [
    "error",
    {
      paths: [
        ...paths,
        {
          name: "@band-app/host-local/git/git-client",
          message:
            "Run git and gh through the Host (host.git.exec / host.git.gh), not the exec helpers. Only pure helpers may be imported.",
          allowImportNames: helpers,
        },
      ],
      patterns: [
        {
          group: [
            "@band-app/host-local",
            "@band-app/host-local/**",
            ...hostLocalAllowed.map((p) => `!${p}`),
          ],
          message: hostLocalMessage,
        },
      ],
    },
  ];
}

const ignored = [
  "**/node_modules",
  "**/dist",
  "**/dist-builder",
  "**/build",
  "**/.build",
  "**/target",
  "**/.next",
  "**/.vinxi",
  "**/.output",
  "**/*.gen.ts",
  "**/.astro",
  "**/test-results",
  "**/playwright-report",
  "**/apps/hub/src/server/infra/db/migrations",
  "**/apps/mobile/ios",
  "**/apps/mobile/build",
  "**/apps/mobile/e2e/artifacts",
];

const scopedGlobs = [
  "apps/hub/src/server/services/**",
  "apps/hub/src/server/api/**",
  "packages/worktree-ops/src/**",
];

const hubStateExempt = [
  "apps/hub/src/server/services/cli-service.ts",
  "apps/hub/src/server/services/worker-cli-service.ts",
  "apps/hub/src/server/services/repo-avatar-service.ts",
  "apps/hub/src/server/services/_utils/upload-utils.ts",
  "apps/hub/src/server/services/_utils/shared-dir.ts",
  "apps/hub/src/server/services/worktree-service.ts",
  "apps/hub/src/server/api/web-app-manifest.ts",
  "apps/hub/src/server/api/queue/router.ts",
  "apps/hub/src/server/api/browser-host/router.ts",
  "apps/hub/src/server/services/repo-service.ts",
  "apps/hub/src/server/services/runner-service.ts",
  "apps/hub/src/server/services/_utils/runner-config.ts",
  "apps/hub/src/server/services/_utils/vault-crypto.ts",
  "apps/hub/src/server/services/ephemeral-lifecycle-service.ts",
  "apps/hub/src/server/services/checkpoint-service.ts",
  "apps/hub/src/server/services/_utils/checkpoint-store.ts",
  "apps/hub/src/server/infra/db/queries/worktree-rekey.ts",
];

const githubServices = [
  "apps/hub/src/server/services/github-webhook-service.ts",
  "apps/hub/src/server/services/github-poll-service.ts",
  "apps/hub/src/server/services/_utils/hub-gh-auth.ts",
  "apps/hub/src/server/services/_utils/worktree-gh.ts",
];

const fmtIgnored = [
  ...ignored,
  "**/*.md",
  "**/*.mdx",
  "**/*.yml",
  "**/*.yaml",
  "**/*.html",
  "**/*.toml",
  "**/*.vue",
  "**/*.svelte",
  "**/*.astro",
  "pnpm-lock.yaml",
  ".am",
];

const cargo = "--manifest-path apps/cli/Cargo.toml";
const clippy = `cargo clippy ${cargo} -- -D warnings`;
const guards = "./scripts/check-worktree-ids.sh && node scripts/check-theme-tokens.mjs";

export default defineConfig({
  run: {
    tasks: {
      // The root scripts in package.json call these. Names differ from the
      // scripts because a task cannot be defined in both places.
      // cache is off on every task: a cache hit replays output only, so it would
      // skip builds that write dist/ and gates that read untracked state.
      "ci:build-web": {
        command: ["pnpm --filter @band-app/web build", "pnpm --filter @band-app/server build"],
        cache: false,
      },
      "ci:lint": { command: `${guards} && vp lint && ${clippy}`, cache: false },
      "ci:format": { command: `vp fmt --check && cargo fmt ${cargo} -- --check`, cache: false },
      "ci:check": {
        command: `${guards} && vp lint && vp fmt --check && cargo fmt ${cargo} -- --check && ${clippy}`,
        cache: false,
      },
      "ci:test": {
        command: [
          "pnpm --filter @band-app/server test",
          "pnpm --filter @band-app/web test",
          "pnpm --filter @band-app/link test",
          "pnpm --filter @band-app/environment test",
          "pnpm --filter @band-app/shared test",
          "pnpm --filter @band-app/client test",
          "pnpm --filter @band-app/host-local test",
          "pnpm --filter @band-app/worker test",
          `cargo test ${cargo}`,
          "pnpm --filter @band-app/desktop test",
        ],
        cache: false,
      },
    },
  },
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    sortPackageJson: false,
    sortImports: {},
    ignorePatterns: fmtIgnored,
  },
  lint: {
    // The old lint covered only these file types. Oxlint also parses .astro/.vue/.svelte.
    ignorePatterns: [...ignored, "**/*.astro", "**/*.vue", "**/*.svelte"],
    plugins: ["typescript", "react", "jsx-a11y", "oxc"],
    categories: { correctness: "error" },
    rules: {
      "no-unused-vars": "warn",
      "typescript/consistent-type-imports": "warn",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "off",
      "react/exhaustive-deps": "warn",
      "react/no-array-index-key": "warn",
      "react/no-danger": "error",
      "no-control-regex": "error",
      "jsx-a11y/no-noninteractive-tabindex": "off",
      "jsx-a11y/no-static-element-interactions": "off",
      "jsx-a11y/no-autofocus": ["error", { ignoreNonDOM: true }],
      "jsx-a11y/prefer-tag-over-role": "warn",
      "jsx-a11y/control-has-associated-label": "off",
      "jsx-a11y/no-noninteractive-element-interactions": "off",
      // Rules the old lint did not enforce, or that flag code it accepted.
      "typescript/no-this-alias": "off",
      "no-unused-expressions": "off",
      "no-irregular-whitespace": "off",
      "oxc/erasing-op": "off",
      // React Compiler rules shipped in oxlint's react plugin. The old lint had no equivalent.
      "react/refs": "off",
      "react/set-state-in-effect": "off",
      "react/immutability": "off",
      "react/purity": "off",
      "react/preserve-manual-memoization": "off",
      "react/static-components": "off",
      "react/globals": "off",
      "react/incompatible-library": "off",
    },
    overrides: [
      {
        files: scopedGlobs,
        rules: {
          "no-restricted-imports": restrictedImports(pureGitHelpers, [...fsPaths, ptyPath]),
        },
      },
      {
        files: hubStateExempt,
        rules: {
          "no-restricted-imports": restrictedImports(pureGitHelpers, [ptyPath]),
        },
      },
      {
        files: githubServices,
        rules: {
          "no-restricted-imports": restrictedImports(pureGitHelpersGh, [...fsPaths, ptyPath]),
        },
      },
    ],
  },
});
