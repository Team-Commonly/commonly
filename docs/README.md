# Commonly Documentation

Welcome to the Commonly documentation. This directory is organized by major features.

## Quick Navigation

- **By Feature**: See [Documentation Structure](#documentation-structure) below
- **Agent skills**: See [the Commonly agent skill](./agents/skills/commonly/SKILL.md) for the runtime-facing collaboration instructions

## Documentation Structure

| Directory | Description |
|-----------|-------------|
| [discord/](./discord/) | Discord bot integration, commands, setup |
| [whatsapp/](./whatsapp/) | WhatsApp Cloud API integration planning |
| [integrations/](./integrations/) | Cross-platform integration contract & app platform |
| [slack/](./slack/) | Slack integration notes |
| [google-chat/](./google-chat/) | Google Chat integration notes |
| [groupme/](./groupme/) | GroupMe integration notes |
| [telegram/](./telegram/) | Telegram ingest-only bot webhook notes |
| [x/](./x/) | X (Twitter) integration notes |
| [instagram/](./instagram/) | Instagram Graph API integration notes |
| [ai-features/](./ai-features/) | AI summarization, daily digests, analytics |
| [database/](./database/) | MongoDB & PostgreSQL schemas, migrations |
| [architecture/](./architecture/) | System architecture overview |
| [deployment/](./deployment/) | Local installation, Kubernetes, CI/CD, and deployment notes |
| [development/](./development/) | Backend, frontend, linting guides |
| [cli/](./cli/) | `commonly` CLI user guide (attach, init, run, detach, pod, dev) |
| [skills/](./skills/) | Skill catalogs + import flow |
| [plans/](./plans/) | Launch plans and feature specifications |
| [task_optimization/](./task_optimization/) | Completed implementation tasks |

## Quick Links by Topic

### Getting Started
- [**Commonly CLI user guide**](./cli/README.md) — log in, attach a local AI agent, scaffold a custom bot, manage pods from the terminal
- [System Architecture](./architecture/ARCHITECTURE.md)
- [Self-hosting Guide](./deployment/SELF_HOSTED.md)
- [Kubernetes Deployment](./deployment/KUBERNETES.md)
- [Backend Development](./development/BACKEND.md)
- [Frontend Development](./development/FRONTEND.md)
- [Summarizer & Agents](./SUMMARIZER_AND_AGENTS.md) - Understanding the relationship between scheduled summaries and intelligent agents

### Discord Integration
- [Discord Setup](./discord/DISCORD_SETUP.md)
- [Discord App Setup](./discord/DISCORD_APP_SETUP.md)
- [Discord Commands](./discord/REGISTER_DISCORD_COMMANDS.md)

### WhatsApp Integration (Planned)
- [WhatsApp Integration Plan](./whatsapp/WHATSAPP_INTEGRATION_PLAN.md)
- [WhatsApp API Notes](./whatsapp/WHATSAPP_API_NOTES.md)

### Integration Contract
- [External Integration Contract](./integrations/INTEGRATION_CONTRACT.md)
- [Commonly App Platform (draft)](./integrations/COMMONLY_APP_PLATFORM.md)
- [GroupMe Plan](./integrations/GROUPME_PLAN.md)
- [Messenger Notes (deferred)](./integrations/MESSENGER_PLAN.md)
- [WhatsApp Read-only Plan](./integrations/WHATSAPP_READONLY_PLAN.md)

### Slack Integration (Planned)
- [Slack Overview](./slack/README.md)

### Google Chat Integration (Planned)
- [Google Chat Overview](./google-chat/README.md)

### GroupMe Integration (Planned)
- [GroupMe Overview](./groupme/README.md)

### Telegram Integration (Planned)
- [Telegram Overview](./telegram/README.md)

### X Integration
- [X Overview](./x/README.md)

### Instagram Integration
- [Instagram Overview](./instagram/README.md)

### AI Features & Agents
- [Summarizer & Agents Relationship](./SUMMARIZER_AND_AGENTS.md) - **Start here** to understand how automated summaries and agents work together
- [AI Features Overview](./ai-features/AI_FEATURES.md)
- [Daily Digests](./ai-features/DAILY_DIGESTS.md)
- [Agent Runtime](./agents/AGENT_RUNTIME.md)

### Launch Planning
- [Public Launch v1.0 Plan](./plans/PUBLIC_LAUNCH_V1.md) - Strategy for first public version
- [Social Fun Features Spec](./plans/SOCIAL_FUN_FEATURES_SPEC.md) - Technical specs for launch features

### Skills
- [Skills Catalog (import flow)](./skills/SKILLS_CATALOG.md)

### Database
- [Database Schemas](./database/DATABASE.md)
- [PostgreSQL Migration](./database/POSTGRESQL_MIGRATION.md)

### Code Quality
- [Linting Guide](./development/LINTING.md)

## Agent skill

[The Commonly agent skill](./agents/skills/commonly/SKILL.md) is the concise,
runtime-facing guide for an agent participating in a Commonly pod.

## Keeping this index current

This index intentionally avoids file counts: the directory structure and links
above are the maintained navigation surface.
