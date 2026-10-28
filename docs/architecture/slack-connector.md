# ADR: Slack connector

**Status:** Proposed · **Date:** 2026-10-28

## Context

People want to talk to an agent from Slack: ask it something in a DM, mention it in a team channel, and have it start real work in their repos. Two existing products shaped this proposal.

- **Orca's connectors** (`stablyai/orca`, `cloud/apps/connector`, behind `experimentalConnectors`). Slack posts events to a cloud service on Orca Cloud, because desktops have no public address. Each machine long-polls that service for its messages, with a short-lived token from Orca Cloud's sign-in. A Slack thread maps to one agent in a fresh worktree. Only the thread's starter can steer it or answer its approvals. Slack users are linked to Orca accounts by an operator, by hand.
- **OpenAI dots.** A dot acts with its owner's connections. Whether it answers other people in a channel, and what it shares with them, is decided by the model and an automatic reviewer, guided by the owner's instructions and Custom Rules. Only access to apps is enforced outside the model. For team use OpenAI uses separate identities: a service account for @ChatGPT and "specialist dots" with their own credentials.
- **Epic's slack-agent platform** (the SSP team's deployment in `ssp-slack-agent`). A relay holds a Socket Mode connection and starts a fresh Kubernetes pod per run. Anyone in the listed channels can use it. Its reach is limited by a repo-scoped GitHub App token minted per run, an egress allowlist, read-only infrastructure roles and a sidecar that holds MCP credentials. Rules such as "never push to protected branches" live only in the prompt.

Band already has most of what a connector needs. The hub is one server in front of every worker, so it can talk to Slack itself. A chat has a queue, status events, permission and form requests, and a session that can be reattached. Agents start worktrees in other repos with the `band` CLI, and origin links record which chat started which worktree. The relay, the MCP proxy, the vault and placement already enforce what an agent on a worker may reach.

## Decision

1. **A bot is a configured Slack identity on the hub.** Settings hold a list of bots. Each has its own Slack app, so two bots appear as two users in Slack and never share tokens. A bot is defined by two lists: who has access to it, and what it can do. There are no bot kinds, owners or roles.

2. **Everyone with access can do everything the bot can do.** Access is a list of Slack user IDs, Slack user groups and channels, plus whether DMs are on. Anyone on it can start threads, steer the bot, answer its questions and approvals, and stop its child agents. Messages from anyone else are ignored and never reach an agent. Guests and Slack Connect users are ignored unless their ID is on the list. The check runs in the hub on the Slack user ID before routing. Setting up a bot for one person means listing only that person. Setting it up for a team means listing the team's channel or group and limiting what the bot can do.

3. **The hub connects to Slack with Socket Mode.** The hub opens an outbound WebSocket (`apps.connections.open`) with the app-level token. That works for every hub, including the desktop app's local hub, and needs no public URL. The bot token (`xoxb-`) and app token (`xapp-`) live in the vault, and settings name the vault items. An HTTP Events mode (`/api/slack/events` and `/api/slack/interactivity`, signature checked before the device-token check like `/api/hooks/github`) can come later for hubs that prefer it. Band ships the Slack app manifest with the scopes it needs.

4. **A Slack thread is one session.** A top-level mention in a channel, or a top-level DM, starts a new chat with a fresh agent session, and the bot answers inside that message's thread. Replies in the thread go to the same chat, found by the label `slack:<team>:<channel>:<thread_ts>`. Replies that arrive during a turn wait in the chat's queue. When the agent process exits or its worker restarts, the next reply reattaches the same session (`session/resume` or `session/load`, as cronjobs do with `strictSession`). When it cannot be reattached, the bot says so in the thread instead of starting a fresh session. Threads share no context. What one thread learns reaches another only through something saved: a repo, a PR or the bot's home repo.

5. **Every session runs in the bot's home worktree.** Each bot has one home repo and worker. All of its thread sessions are chats in one worktree of that repo. The home repo holds the bot's instructions and any context or skills its owner adds. Band writes an `AGENTS.md` template there when the bot is created, and a `CLAUDE.md` that points to it. The template tells the agent:
   - This worktree is the bot's home. Do not edit, commit or create files in it.
   - For any change to code or docs, create a worktree in the target repo with `band worktrees create <repo> <branch> --prompt "…"`, and steer that agent with `band chats send`.
   - Answer in the thread. Report what child agents did with links, not whole diffs.
   - Wait for child agents, PRs and CI with `band subscriptions`, not by polling.

   The template uses only the `band` CLI and the skills Band installs (`band`, `band-start`, `band-chat`, `band-subscribe`), never skills a particular user has. Nothing enforces the no-edit rule yet.

6. **Work happens in child worktrees, and children report to the thread.** A worktree the bot creates records the thread's chat as its origin (origin links already take it from `x-band-chat-id`). The hub uses that link to post to the thread when a child's turn ends, when it opens a PR, when CI on its branch finishes, and when it asks a question or needs a permission. The same events wake the bot's session, like a subscription, so it can decide what to do next. Children outlive the thread's activity and keep working after people stop replying. Removing a child is its own step, as for any worktree.

7. **What the bot can do is enforced by the hub.** A bot's settings name:
   - the repos its child worktrees may use, checked by the relay on `worktrees.create` and `agentSessions.launch`,
   - the workers its home and children may run on, checked by placement,
   - its MCP servers (`mcpServers` of the sessions), its vault scope and its agent login,
   - its limits: child agents per thread and in total, the longest turn, and a daily budget.

   Children inherit their bot's settings through the origin link. The agent cannot widen any of this by what it is told, because the relay, placement, the MCP proxy and the vault check the bot, not the prompt. A bot reaches only the workers it is given, so a bot for a team should run on workers that hold nothing personal.

8. **Approvals are held by the relay and answered with buttons.** Per-action rules (`git.push`, `pr.create`, `pr.merge`, `worktree.remove`, other state-changing `band` calls) are set to allow, approve or never. "Approve" makes the relay hold the call and post an Approve / Deny card in the thread. "Never" makes the relay refuse it. An agent's own permission and form requests also become cards. Anyone with access can press the buttons, and only their presses count. Holding a relay call until a person answers is new: today the relay can only allow or refuse.

9. **What goes back to Slack.** One status line per thread, edited as the chat's status changes (working, question, done, failed), or a reaction. The agent's last message at the end of each turn, split into several messages or attached as a file above Slack's 4,000-character limit. Links to the worktree and chat in Band. Images in Slack messages become chat uploads, and files the agent shares can go back as Slack files.

10. **Triggers and scheduled posts.** Besides mentions and DMs, a bot can start a thread from a rule on a message's text or author in an allowed channel, for example an alert from another bot. A Band cronjob can name a bot and a channel, so a scheduled prompt posts its result there, for example a daily PR digest.

11. **Every decision is logged.** One row per event: the Slack user, channel and thread, the chat and worktree, and whether it was routed, ignored or refused, with the reason. Read with `slack.audit`, like `mcp.audit` and `workers.audit`. No row holds a token or a message's full text.

12. **Settings and API.** `slack.*` tRPC procedures (list, create, update, remove, test, audit) are admin only, left out of the MCP endpoint, and refused by the relay (`NEVER_FOR_AGENTS`). Settings > Slack lists the bots, with the connection, access, home, reach, approvals, triggers and limits of each, and a Test button that checks the tokens and shows the bot's Slack user and workspace.

Settings for one bot, as stored:

```json
{
  "id": "band-dev",
  "enabled": true,
  "slack": { "mode": "socket", "botToken": "vi_200", "appToken": "vi_201" },
  "access": {
    "users": ["U01ALEKSANDAR"],
    "groups": ["S0BANDDEVS"],
    "channels": ["C0BANDDEV"],
    "dms": true
  },
  "home": { "repo": "band-bot", "worker": "h-team-1" },
  "children": {
    "repos": ["band", "band-docs"],
    "workers": { "labels": ["pool=team"] },
    "maxPerThread": 3,
    "maxTotal": 8,
    "report": ["turn-end", "pr", "ci", "questions"]
  },
  "reach": { "mcp": ["band", "github"], "vaultScope": "bot:band-dev", "agentLogin": "al_team" },
  "approvals": { "pr.merge": "approve", "worktree.remove": "never" },
  "triggers": [{ "channel": "C0ALERTS", "authorBot": "B0GRAFANA", "textContains": ["FIRING"] }],
  "limits": { "turnMinutes": 60, "dailyBudgetUsd": 50 }
}
```

## Phases

1. **One bot, threads, home worktree.** Socket Mode, access list, sessions per thread in the home worktree with the `AGENTS.md` template, the last message posted at the end of each turn, status line, audit log. Children are created through the `band` CLI with origin links, without reports to the thread yet.
2. **Children report to the thread.** Turn ends, PRs, CI and questions of child worktrees post to the thread and wake the bot's session.
3. **Reach and approvals.** Repos, workers, MCP servers, vault scope and agent login per bot, enforced by the relay and placement. Relay calls held for approval, and Approve / Deny cards.
4. **Triggers, scheduled posts, limits.** Message rules, cronjobs that post to a channel, child and budget limits.
5. **HTTP Events mode** for hubs that want it.

## Consequences

Positive:

- No cloud service. The hub talks to Slack directly, and Socket Mode works for hubs without a public URL.
- Access and reach are two settings a person reads and changes, not judgments the model makes.
- The bot works the way a person works with an agent in Band today: talk in one place, start work in worktrees, follow it from the thread.

Negative:

- Everyone with access gets everything the bot can do. A bot shared by a team must be set up with that team's reach, on workers that hold nothing personal.
- The no-edit rule for the home worktree is only an instruction for now.
- Holding a relay call until a person answers is a new mechanism, and approvals depend on it.
- A long agent answer does not fit one Slack message and needs splitting or a file.
- Slack users are not Band users. Access is by Slack ID, and Band has no record of which Slack user is which person beyond that.

## Not decided

- Separate hubs or workspaces per team. With several teams on one hub, today's settings, vault and workers are shared, and only the bot's reach separates them.
- Discord, Microsoft Teams or other chat apps through the same service.
- A per-bot egress allowlist on container workers, and GitHub tokens minted per run and limited to the bot's repos.
