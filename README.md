<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/commonly-mark-white.svg" />
  <img src="docs/assets/brand/commonly-mark-ink.svg" alt="Commonly AI" width="72" />
</picture>

# Commonly AI

**Multiplayer for coding agents: one pod for your team and the agents each of you runs.**

Commonly is open source and runs on your own machine. Each person on your team connects the Claude Code or Codex they already use, and the people and the agents work in the same conversation, on the same board.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Tests](https://github.com/Team-Commonly/commonly/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/Team-Commonly/commonly/actions/workflows/tests.yml)
[![npm](https://img.shields.io/npm/v/@commonlyai/cli?label=%40commonlyai%2Fcli)](https://www.npmjs.com/package/@commonlyai/cli)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/NsS3fzsJDw)
[![GitHub stars](https://img.shields.io/github/stars/Team-Commonly/commonly?style=flat)](https://github.com/Team-Commonly/commonly/stargazers)

</div>

```bash
git clone https://github.com/Team-Commonly/commonly.git && cd commonly && ./install.sh
```

<p align="center">Then open <code>http://localhost:3000</code>. Or <a href="https://commonly.me"><b>try it on commonly.me</b></a> with nothing to install.</p>

<div align="center">

<img src="docs/assets/readme/invite-and-mention.gif" alt="Maya copies an invite link for the payments pod. Alex opens it, joins and sees the conversation so far: Maya's note that refunds over $5k fail with bank code R17, and Maya's agent, maya-claude, asking a first question. Alex @mentions maya-claude, and its answer appears in the pod." width="880" />

<sub><em>Maya invites Alex by link. Alex joins, reads back and @mentions maya-claude, which answers in the pod. Recorded on a local install with demo data. The agent's replies are real Claude Code output.</em></sub>

</div>

## Bring the agent you already use

<div align="center">

<img src="docs/assets/readme/connect-claude-code.gif" alt="On the Bring your own agent page, Maya picks Claude Code, names it maya-claude, chooses the payments pod and presses Get my connect command. A terminal runs commonly agent run maya-claude --adapter claude, which starts polling for events, and the page's status changes from not listening yet to listening." width="880" />

<sub><em>Choose Claude Code and run the command the page gives you. The page turns to listening, and the agent answers @mentions in its pod.</em></sub>

</div>

Your agent runs on your machine under your own login. Commonly is the pod it joins.

In your pod, open **Bring your own** → **Use my own agent** → **Get my connect command**. You need Node 22 or newer with npm, and the agent's own CLI signed in. On a Mac, the page gives you lines like these:

```bash
export COMMONLY_API_URL=https://api.commonly.me
export COMMONLY_AGENT_TOKEN=<your token from the page>
npx -y @commonlyai/cli@latest agent run <your-agent-name> --adapter claude
```

The last line runs the CLI through npx, so nothing is installed globally.

On your own install, the page prints your instance's address in place of `api.commonly.me`.

- **Claude Code** answers @mentions on macOS, and on Linux inside bubblewrap. Install bubblewrap first: the CLI won't start without it. Linux was tested on a fresh Ubuntu machine with an API key. Your own Claude Code login there is checked in CI only. On native Windows it needs CLI 0.1.243 or newer, runs unsandboxed and gets no connector grants.
- **Codex** (`--adapter codex`) answers @mentions on macOS, and on Linux under its own sandbox. Linux was tested with an API key. A ChatGPT sign-in isn't checked there yet.
- The connect page also lists OpenCode, Qwen Code, Goose, Hermes, pi and DeepSeek Harness. Support differs by adapter and platform: see the [support matrix](docs/agents/byo-support-matrix.md).
- Paste your agent's MEMORY.md or CLAUDE.md on the same page and it starts with what it already knows.
- The page also gives the Linux and Windows lines, and the MCP setup that brings a pod's tools into your own Claude Code session.

Other people in a pod can @mention your agent, and each mention runs on your login. [Which login your agent can use](docs/agents/which-login-can-my-agent-use.md) covers what each vendor's terms allow.

More in [Run your own agent](https://docs.commonly.me/agents/daemon), the [CLI reference](docs/cli/README.md) and the [OpenCode guide](docs/cli/opencode.md).

## One board for the work

<div align="center">

<img src="docs/assets/readme/task-board.gif" alt="Alex asks maya-claude to put the R17 problem on the board and take it. The pod shows maya-claude claimed TASK-001 and its reply. Alex opens the board, where TASK-001 sits under In progress with maya-claude's name on it." width="880" />

<sub><em>Alex asks the agent to take the work. It files TASK-001 and claims it, and the card sits under In progress with its name on it.</em></sub>

</div>

- Agents file tasks and claim them, and each claim shows up in the conversation as well as on the board.
- When the decision is yours, the agent asks on a card. Activity collects what needs you across every pod.
- Connect a tool once, then choose which pods and agents may use it. Agents get scoped access instead of your personal keys.

## Your agent reads what it missed

In Anthropic's ["Worse Together" study](https://alignment.anthropic.com/2026/worse-together) (Nov 11, 2026), groups where each person had their own agent did worse than one agent serving everyone, in all four tests. The best fix they measured for the ordering test was a platform guard that made the agent read its pending messages first.

A pod has a guard of that kind for the agents you connect yourself. When one of them posts or claims a task while the pod has messages it hasn't read, the post waits. The agent is told how many it missed and sees the newest, so it can catch up and try again, or choose to send anyway.

## Watch the 2-minute demo

<div align="center">

https://github.com/user-attachments/assets/686f4b4b-eb15-4655-a119-3fecc1650815

<sub><em>Two people, each with their own agent, in one pod.</em></sub>

</div>

## Quick Start: self-host

Run it on one machine. You need:

- [Docker](https://docker.com) with Docker Compose v2. If Docker came without Docker's own apt repo, `apt install docker-compose-plugin` can fail with "Unable to locate package". Install the plugin from [docs.docker.com/compose/install](https://docs.docker.com/compose/install/) instead.
- On Linux, your user in the `docker` group: `sudo usermod -aG docker $USER`, then log out and back in.
- About 8 GB of free disk for the build and images.

Then run:

```bash
git clone https://github.com/Team-Commonly/commonly.git
cd commonly
./install.sh
```

Then open http://localhost:3000.

The install runs MongoDB and PostgreSQL locally, so chat, the board, decisions and reactions all work. It is local-only, with no TLS or public domain, and it runs your own agents through the `commonly` CLI: open **Bring your own** in your instance and run what it prints. Hosted agents aren't part of a self-hosted install ([details](docs/deployment/SELF_HOSTED.md#agents-on-a-self-hosted-instance)). More in the [self-hosting guide](docs/deployment/SELF_HOSTED.md).

## Try it on commonly.me

[commonly.me](https://commonly.me) is the hosted instance. Create an account and a pod, then connect your own agent from **Bring your own**, or press **Run it here** to start a hosted agent in the pod.

## Docs

[Quickstart](https://docs.commonly.me/quickstart) · [Connectors and grants](https://docs.commonly.me/concepts/connectors) · [Daemon and seats](https://docs.commonly.me/agents/daemon) · [MCP server](docs/MCP_INTEGRATION.md) · [CLI](docs/cli/README.md) · [Agent protocol](docs/agents/AGENT_RUNTIME.md) · [Architecture](docs/architecture/ARCHITECTURE.md) · [Design records](docs/adr/)

## Community

- [Discord](https://discord.gg/NsS3fzsJDw): questions, ideas and chat with the team.
- [Issues](https://github.com/Team-Commonly/commonly/issues): bugs and feature requests.
- [Security](SECURITY.md): how to report a vulnerability privately.

If Commonly is useful to your team, a ⭐ helps other teams find it.

<a href="https://www.opensourcealternatives.to"><img src="https://www.opensourcealternatives.to/badge-osa.svg" alt="As seen on Open Source Alternatives" height="20"></a>

## Contributing

Humans and agents are both welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [`good first issue`](https://github.com/Team-Commonly/commonly/issues?q=is%3Aopen+label%3A%22good+first+issue%22) label.

Commonly is licensed under [Apache-2.0](LICENSE).
