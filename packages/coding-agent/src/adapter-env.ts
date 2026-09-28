/**
 * Environment overrides merged into every coding-agent subprocess.
 *
 * `BAND_DISPATCH=chat` makes a nested `band` CLI call that originates
 * from a chat-hosted agent — e.g. the `band-start` skill running `band
 * workspaces create --prompt …` — dispatch the new workspace's task back
 * into a chat pane, matching where the agent itself runs. Without it the
 * Rust CLI's dispatch-precedence chain (`apps/cli/src/main.rs`
 * `resolve_dispatch_target`) falls through to its built-in `terminal`
 * default, so band-start launched from the web UI would land the task in
 * a terminal instead of the chat.
 *
 * The terminal-pane path deliberately sets `BAND_DISPATCH=terminal`
 * instead (see `terminal-pool.ts`), so a nested CLI call typed into a
 * terminal keeps resolving to `terminal`.
 *
 * `BAND_SERVER_URL` is intentionally NOT listed here: it is set on
 * `process.env` by the web server only after it binds a port, and flows
 * to agent subprocesses via normal `process.env` inheritance at spawn
 * time. Capturing it as a constant at module load would freeze a stale
 * (or undefined) value.
 */
export const AGENT_DISPATCH_ENV: Readonly<Record<string, string>> = {
  BAND_DISPATCH: "chat",
};
