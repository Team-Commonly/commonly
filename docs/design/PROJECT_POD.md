# Project Pod

## Summary

`Project` is a new pod type for work coordination between humans and agents.

It keeps the pod model, chat transport, agent installs, and shared memory that already exist in Commonly, but it replaces the generic pod presentation with a dedicated execution-first workspace:

- `Chat` tab:
  - persistent project header
  - main chat as the primary collaboration surface
  - right sidebar for brief, success criteria, key links, owners, blockers, and member/agent context
- `Tasks` tab:
  - full task navigator + task detail workspace
  - no board view
  - task actions centered on assignment, progress, blockers, and completion

The intent is to shift Commonly from "social/chat with tasks attached" toward "work coordination with chat built in."

## Goals

- Keep pods as the collaboration boundary.
- Add a work-first pod template without breaking existing chat/study/game/team pods.
- Make humans and agents feel like members of the same delivery team.
- Track execution state in structured task records instead of freeform chat.
- Preserve existing agent runtime/event plumbing so project pods participate in the same ecosystem.

## UX

### Header

The top of a project pod always shows:

- project name
- short description
- project health/status
- due date
- open-task and blocker counts
- primary actions: `New Task`, `Edit Project`

### Chat Tab

The chat tab stays primary for day-to-day collaboration.

Layout:

- main center column: chat stream + composer
- right sidebar:
  - brief/goal
  - scope
  - success criteria
  - key information
  - key links
  - members and installed agents

Rule:

- chat is for discussion
- task updates may be discussed in chat
- source of truth for execution lives in tasks, not chat messages

### Tasks Tab

The tasks tab is not a kanban board.

Layout:

- left rail:
  - search
  - filters (`all`, `mine`, `human`, `agent`, `blocked`, `done`)
  - task list
- main pane:
  - task header and status
  - assignee/meta chips
  - description
  - blocker state
  - update timeline
  - task action buttons

## Task Workflow

Current implementation maps onto the existing backend task statuses:

- `pending` → Todo
- `claimed` → In Progress
- `blocked` → Blocked
- `done` → Done

Supported actions in the project pod UI:

- `Take task`
- `Assign`
- `Post progress`
- `Raise blocker`
- `Clear blocker`
- `Complete`

## Data Model

### Pod

`Pod.type` now includes `project`.

`pod.projectMeta` stores project-level information:

- `goal`
- `scope`
- `successCriteria[]`
- `status`
- `dueDate`
- `ownerIds[]`
- `keyLinks[]`

### Task

Tasks extend the existing schema with structured work fields:

- `description`
- `assigneeType`
- `assigneeRef`
- `priority`
- `dueDate`
- `progressPercent`
- `blocker`
- structured `updates.kind`
- structured `updates.progressPercent`
- structured `updates.nextStep`

This is intentionally incremental. It upgrades the current task system without introducing a separate `ProjectTask` collection.

## Agent Workflow

Project pods reuse the current agent installation and runtime architecture.

Key changes:

- runtime pod creation now accepts `project`
- task assignment to an agent emits `task.assigned`
- agent assignees are modeled explicitly through `assigneeType="agent"` and `assigneeRef=<instanceId>`

Expected agent behavior in project pods:

- take or receive assigned work
- post progress updates
- raise blockers
- complete tasks with structured history

## Infra / DB Notes

- MongoDB remains the source of truth for project pod metadata and tasks.
- No new infrastructure tier is required for MVP.
- Existing Socket.io `task_updated` events continue to drive live task refresh.
- Existing runtime polling/native-dispatch model remains valid.

## Rollout

### Phase 1

- add `project` pod type
- add `projectMeta`
- add dedicated frontend project room
- add structured task fields

### Phase 2

- expand task/project reporting
- add richer milestone support
- add project-specific agent tools for progress/blocker management

### Phase 3

- add deeper automation: standups, stale blocker reminders, milestone risk summaries

## Current MVP Status

The current implementation covers the first slice of the project pod idea:

- `project` is a real pod type
- project pods have a dedicated two-tab UI:
  - `Chat`
  - `Tasks`
- project pods support project-level metadata through `pod.projectMeta`
- tasks support richer fields:
  - `description`
  - typed assignees
  - `priority`
  - `dueDate`
  - `progressPercent`
  - `blocker`
  - structured updates
- assigning a task to an agent emits `task.assigned`

This is enough for an MVP, but it is not yet the full project-coordination system described in the original vision.

## Remaining Work

### Project Creation UX

The current pod creation flow only lightly seeds project metadata.

Still needed:

- dedicated `Create Project Pod` flow
- structured input for:
  - goal
  - scope
  - owners
  - due date
  - success criteria
  - key links

### Milestones

There is no milestone model yet.

Still needed:

- first-class milestone records
- milestone status/health
- task ↔ milestone linkage
- milestone summaries in the project sidebar

### Task Workflow

The current backend status model is still implementation-shaped:

- `pending`
- `claimed`
- `blocked`
- `done`

Still needed:

- clearer product-facing workflow such as:
  - `todo`
  - `in_progress`
  - `blocked`
  - `in_review`
  - `done`
- migration/update plan for existing tasks

### Task Structure

The current task model is richer than before, but still incomplete for real project execution.

Still needed:

- checklist/subtask support in the dedicated project UI
- acceptance criteria
- review state
- handoff target/state
- stronger dependency visualization
- overdue and due-soon signals

### Agent Workflow

The current implementation emits `task.assigned` for agent assignees, but the broader work loop is still incomplete.

Still needed:

- agent tools/runtime support for:
  - take task
  - post progress
  - raise blocker
  - clear blocker
  - complete task
- better task-state mirroring between runtime actions and UI state
- clearer distinction between chat participation and work ownership

### Chat Tab Context

The right sidebar exists, but it still needs more live execution surfaces.

Still needed:

- `Assigned to me`
- `Agent tasks`
- `Open blockers`
- `Due soon`
- `Recent decisions`

### Activity / Timeline

The current two-tab model intentionally avoids adding a separate timeline page.

Still needed:

- compact project activity stream inside existing tabs
- visibility for:
  - progress updates
  - blockers
  - handoffs
  - completions
  - major decisions

### Assignment Identity

The model now supports `assigneeType` and `assigneeRef`, but there is still some reliance on human-readable labels.

Still needed:

- make typed identity the source of truth everywhere
- treat display labels as presentation only
- tighten agent installation lookup paths

### Database / Query Support

MongoDB is still the right store for this phase, but indexing/query support should be improved.

Still needed:

- indexes for:
  - `podId + status`
  - `podId + assigneeRef`
  - `podId + dueDate`
  - `podId + blocker.open`

### Documentation

The dedicated design doc exists, but broader product and engineering docs still lag the implementation.

Still needed:

- update architecture/backend/frontend/database docs
- update API docs for project pod fields and task fields
- document project pod creation and usage flow

### Verification / Tooling

Backend and frontend verification should be part of the rollout path.

Still needed:

- ensure dev containers always have full dev toolchains
- run backend test/typecheck coverage against the new task/project paths
- expand frontend coverage beyond route/browse behavior

## Open Follow-Ups

- milestone model is still lightweight and should likely become first-class later
- project pod chat currently reuses message transport but not the full legacy chat feature surface
- future task status normalization should likely move from `pending/claimed/done` to clearer product-facing workflow names
