---
title: Agent logins
description: Give a coding agent a credential from the hub's vault, so a worker with no login of its own can run it.
section: agents
order: 70
---

A coding agent needs a credential. By default each machine uses its own login: the one `claude auth login` or `codex login` left there. An agent login is a credential that the hub holds in its vault and hands to an agent when Band starts it, on the hub's machine or on a worker. A worker with no login of its own can then run the agent.

This covers only credentials that work on any machine: a Claude Code setup token, and API keys. Logging in on a worker from the UI, a shared Codex `auth.json`, gateway logins and a model API proxy are not supported yet.

## Terms and a warning

Anthropic's terms say a third party may not "collect, store, or intermediate Claude.ai credentials or session tokens". A setup token (`claude setup-token`) is a Claude.ai credential. Storing your own token in a hub you run yourself may still fall under that sentence. Band does not decide this for you. If you are unsure, use an Anthropic API key login instead, or leave the agent on the machine's own login.

A setup token also cannot use Remote Control or claude.ai connectors. Use an API key or the machine's login for work that needs them.

## Set up

Open Settings > Agent logins. An admin device token is needed. Other tokens see a notice.

1. Pick the kind, give the login a label and paste the secret. The hub writes the secret to the vault as a global item named `agent-login:<id>` and never returns it.
2. Pick a default login for the agent. With none, the agent uses the machine's own login, as before.
3. To use another login in one repo, set it under that repo in Settings > Repos.
4. A chat can pick its own login from the menu next to the model. The menu appears when the agent has at least one login.

The pick applies the next time the agent starts. A running agent keeps the credential it started with.

## Which login wins

At each agent start the hub takes the first of these that exists:

1. The chat's pick.
2. The repo's override for that agent type.
3. The default for that agent type.
4. None, which leaves the environment as it is.

A login whose vault item is gone is skipped, and the next entry applies. Settings > Agent logins shows it as "missing secret". The hub reads the vault on every start, so a rotated or deleted secret takes effect on the next start.

## What the agent gets

The hub adds the variables of the chosen kind to that one process, and removes the variables that would override it. Nothing is written to a settings file or a log, and a terminal that Band restores later does not keep it.

| Agent | Kind | Variable set | Removed from the environment |
| --- | --- | --- | --- |
| claude-code | Setup token | `CLAUDE_CODE_OAUTH_TOKEN` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` |
| claude-code | API key | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` |
| codex | API key | `OPENAI_API_KEY`, `CODEX_API_KEY`, and `DEFAULT_AUTH_REQUEST={"methodId":"api-key"}` | none |
| opencode | Provider API key | one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` | none |
| gemini-cli | API key | `GEMINI_API_KEY` | `GOOGLE_API_KEY` |
| cursor-cli | API key | `CURSOR_API_KEY` | none |

Amp and Copilot are in the table for completeness. Band has no agent definition for them yet, so Settings > Agent logins lists only the agents you have enabled.

### Codex

The Codex ACP adapter reads `CODEX_API_KEY` first and `OPENAI_API_KEY` second, and uses the key only when it signs in with the API-key method. Band sets `DEFAULT_AUTH_REQUEST` so the adapter signs in with the key when the machine has no Codex login.

A login or provider already configured for Codex on the machine wins. The adapter signs in with the key only when Codex reports that it needs authentication, and a ChatGPT login or a configured provider means it does not. Making the key win would need a separate `CODEX_HOME` per login, which Band does not do yet. Until then, a Codex API key login is used only on workers with no Codex login or provider of their own, such as a fresh worker.

## Exposure and trust

The agent holds its credential in its environment, so it can print it. A tool call such as `env` writes the secret into the chat's tool output, and so into the chat history. Treat a login as exposed to everything that agent can do.

Band replaces the exact value of a login's secret in the agent's stderr and in the errors it raises, so a key that an agent prints when it fails to authenticate does not reach the failure card or the chat log. A copy that the agent encodes first (JSON escapes, URL encoding) is not recognised, and neither is output the agent writes on purpose.

Workers with the `restricted` [trust level](agent-host-access.md) receive logins like any other worker. Trust limits what an agent may call through the relay. It does not limit the credential the agent itself runs on, and ephemeral runner workers, which are `restricted` by default, are a main use for logins. An agent on any worker can see its own login, as above.

An agent on a worker cannot read a login or switch its own chat to another account, at any trust level. An agent on the hub's own machine cannot pick its own login either.

A worker that owns its chats (`--own-chats`) keeps the login out of its local cache. If the hub is unreachable when such a chat starts its agent, the worker falls back to the cached launch, which has no login, and the agent runs on the machine's own login.


## Where logins apply

- Chats on the hub's machine and on a worker. The hub sends the variables to the worker with the launch, and the worker removes the listed variables before it starts the agent.
- Agents in a terminal, started with `band agents launch --mode tui` or from the New agent menu.
- Model lists and one-off calls use the agent's default login.

A terminal that Band restores after a daemon restart, or that you open again by hand, starts without the login.

## Status

A worker that reports an agent as installed but not logged in counts as able to run it when a login exists for that agent type. The worker list, placement and [follow the work](follow-the-work.md) all apply this.

## Access

Managing logins needs an admin device token. An agent cannot read or change a login. The chat's login menu shows the names of logins to every device, never the secrets.
