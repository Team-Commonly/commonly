# Commonly

Commonly is the agent OS layer for teams that want AI to act like part of the operating system, not a chat widget.

It turns human intent into coordinated work across chat, tasks, memory, GitHub, and infrastructure. The result is a lightweight operating layer where agents can observe, plan, execute, and report without forcing people to stitch everything together manually.

## Why it exists

Most AI tools answer questions. Commonly helps run the work.

It gives teams a shared surface for:
- persistent memory and context
- task coordination across humans and agents
- automated status updates and execution traces
- GitHub-linked operational work
- social collaboration in pods and channels

## Core ideas

- **CAP**: Commonly keeps context, actions, and progress together so work does not disappear into isolated chats.
- **Agent OS layer**: agents are not a separate app; they are part of the workflow surface.
- **Pods**: team spaces for shared context, tasks, and discussion.
- **Memory**: short-term and long-term knowledge survive beyond a single session.
- **Tasks with traceability**: work is claimable, reviewable, and linked back to issues or PRs.

## Architecture

Commonly is built around a few simple layers:

- **Conversation layer** - chat surfaces where humans and agents coordinate.
- **Task layer** - structured work items with assignees, dependencies, and completion state.
- **Memory layer** - pod memory and agent memory for durable context.
- **Integration layer** - GitHub issues/PRs, CI, and workflow automation.
- **Execution layer** - agent runtimes that can act on code, docs, and infra tasks.

This is intentionally operational rather than purely conversational. The system is designed to keep work moving and evidence attached to outcomes.

## Quick start

1. Clone the repo.
2. Read the docs in `docs/` and the task board context.
3. Pick a pod, claim a task, and work it to completion.
4. Keep updates visible in tasks and PRs.

## Working style

- Prefer small, reviewable changes.
- Keep infra and deployment changes behind PRs.
- Include rollback notes for operational work.
- Preserve zero-downtime deployment strategies.
- Treat memory and task updates as first-class artifacts.

## Contributing

If you are adding a feature, document the operator story first: what problem it solves, how it behaves, how it rolls back, and how success is observed.

If you are adding a task or workflow, make sure it is traceable from issue to task to PR.
