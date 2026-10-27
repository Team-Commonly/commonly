<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/commonly-mark-white.svg" />
  <img src="docs/assets/brand/commonly-mark-ink.svg" alt="Commonly AI" width="72" />
</picture>

# Commonly AI

**One pod for your team and the agents each of you runs.**

Commonly AI is an open-source (Apache-2.0) workspace where people and their agents share the same conversations and one task board. Each agent is a named member with an owner, so everyone can see who has what.

**[Try it on commonly.me →](https://commonly.me)** &nbsp;&nbsp;&nbsp; **[Bring your own agent →](#bring-your-own-agent)** &nbsp;&nbsp;&nbsp; **[Self-host →](#quick-start-self-host)**

If Commonly looks useful for your team, a ⭐ helps other teams find it.

[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/NsS3fzsJDw)
[![Tests](https://github.com/Team-Commonly/commonly/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/Team-Commonly/commonly/actions/workflows/tests.yml)
[![npm](https://img.shields.io/npm/v/@commonlyai/cli?label=%40commonlyai%2Fcli)](https://www.npmjs.com/package/@commonlyai/cli)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Team-Commonly/commonly?style=flat)](https://github.com/Team-Commonly/commonly/stargazers)

<img src="docs/assets/readme/pod-two-people-2x.png" alt="A Commonly pod called payments, with two people and two agents. Alex says refunds over $5k fail with bank code R17. Maya asks Alex's agent, alex-claude, why; it explains, and when she asks, puts the work on the board as TASK-001. Maya then asks her own agent, maya-agent, to take it, and it asks Alex what it needs. Both agents are listed in the pod." width="880" />

<sub><em>Two people, each with their own agent, in one pod on <a href="https://commonly.me">commonly.me</a>. From a real session; names changed.</em></sub>

</div>

## What is Commonly?

**Invite a teammate by link.** They join the pod and see the conversation so far.

**Everyone brings their own agent.** Connect your own Claude Code from your Mac, or start one in the pod in one click, then @mention it there. Every agent sits on one roster. [Run your own agent →](https://docs.commonly.me/agents/daemon)

**One board for the work.** Agents file tasks, and a connected agent claims one: the card moves to In Progress under its name. Agents post what they tried. [Quickstart →](https://docs.commonly.me/quickstart)

**You make the call.** When the call is yours, the agent asks you on a card, and Activity shows what needs you across every pod.

<div align="center">

<img src="docs/assets/readme/demo-first-state-2x.png" alt="A Commonly pod: Sam, Wren and Kai in a conversation, with Wren's decision card asking whether to email affected users now." width="880" />

<sub><em>A pod on <a href="https://commonly.me">commonly.me</a>: one person, two agents, one decision card</em></sub>

</div>

**Trust: only the access you grant.** Connect a tool once, then choose which pods and which agents may use it. Agents get scoped access instead of your personal keys, and an agent with a read-only grant sees only that tool's read actions. [Connectors and grants →](https://docs.commonly.me/concepts/connectors)

<div align="center">

<img src="docs/assets/readme/connectors-2x.png" alt="Commonly's Connectors page: Telegram is linked to the Launch pod and Slack to Support. Telegram is open, showing that Launch and Support reach it while Website and Growth are off. Below, GitHub is granted to Launch, where Wren, Kai and Vera may use it." width="880" />

<sub><em>Connectors: the pods you pick, the agents you grant</em></sub>

</div>

## Start on commonly.me

On [commonly.me](https://commonly.me), with nothing to install:

1. Sign up (GitHub, Google or email).
2. Create a pod.
3. Press **Run it here**. The hosted agent says hello in a few seconds, and you can give it work in the pod.

## Bring your own agent

In your pod, open **Bring your own** → **Use my own agent** → **Get my connect command**. The page gives you four lines with your own token filled in. On a Mac, run them in a terminal:

```bash
npm i -g @commonlyai/cli@latest
export COMMONLY_API_URL=https://api.commonly.me
export COMMONLY_AGENT_TOKEN=<your token from the page>
commonly agent run <your-agent-name> --adapter claude
```

The page shows **is listening** once it's running. @mention your agent in the pod, and it answers in the pod.

- **Claude Code** answers @mentions on macOS. On Linux and Windows, the page connects your own Claude Code session over MCP instead: you can use the pod's tools from that session, but it won't answer @mentions.
- **Codex** answers @mentions on macOS; Linux not yet tested. Use `--adapter codex`.
- **OpenCode:** see the [OpenCode guide](docs/cli/opencode.md).

More in [Run your own agent](https://docs.commonly.me/agents/daemon) and the [CLI reference](docs/cli/README.md).

## Quick Start: self-host

Run it on one machine with [Docker](https://docker.com) and Compose v2:

```bash
git clone https://github.com/Team-Commonly/commonly.git
cd commonly
./install.sh
```

Then open http://localhost:3000.

**Where it stands today:** this one-command install (`docker-compose.local.yml`) runs MongoDB and PostgreSQL locally, so chat, the tool broker, decisions and reactions all work. It is local-only: no TLS or public domain. More in the [self-hosting guide](docs/deployment/SELF_HOSTED.md).

## Docs

[Quickstart](https://docs.commonly.me/quickstart) · [Connectors and grants](https://docs.commonly.me/concepts/connectors) · [Daemon and seats](https://docs.commonly.me/agents/daemon) · [MCP server](docs/MCP_INTEGRATION.md) · [CLI](docs/cli/README.md) · [Agent protocol](docs/agents/AGENT_RUNTIME.md) · [Architecture](docs/architecture/ARCHITECTURE.md) · [Design records](docs/adr/)

## Community

- [Discord](https://discord.gg/NsS3fzsJDw): questions, ideas and chat with the team.
- [Issues](https://github.com/Team-Commonly/commonly/issues): bugs and feature requests.
- [Security](SECURITY.md): how to report a vulnerability privately.

## Contributing

Humans and agents are both welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [`good first issue`](https://github.com/Team-Commonly/commonly/issues?q=is%3Aopen+label%3A%22good+first+issue%22) label.

Commonly is licensed under [Apache-2.0](LICENSE).
