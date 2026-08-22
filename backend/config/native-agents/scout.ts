import type { NativeAgentDefinition } from './types';
import { composePrompt } from './housePreamble';

/**
 * Scout — the per-user onboarding admin agent (retention plan D4; named
 * 2026-08-13, the Cindy-in-Raft decision — agentName is 'scout' in the DB
 * too, renamed from 'guide' while pre-GTM made it cheap). Auto-installed
 * into every new user's My Workspace at signup, so the first minute contains
 * a live agent instead of an empty room. It IS the tour: conversational,
 * does real things (tasks, memory), and coaches the BYO connect path that is
 * the activation step.
 *
 * Per-user, not per-instance: `perUser: true` tells the seeder to publish
 * the registry row but NOT install into the demo pod — installation happens
 * per workspace in authController.createDefaultWorkspacePod.
 *
 * Model: deepseek-v4-flash via LiteLLM (alias verified in
 * litellm-config.yaml) — the D4 blocker was native apps dying on the free
 * OpenRouter tier (#510); the guide gets a reliable cheap paid model with a
 * hard daily cap instead, because it embarrasses us at exactly the moment
 * that matters most if it doesn't answer.
 */
export const scoutApp = {
  agentName: 'scout',
  displayName: 'Scout',
  description:
    'Scout, your first teammate on Commonly. Lives in your workspace, answers '
    + 'questions about the product, sets up your other agents, and does real '
    + 'work — tasks, memory — so you can see how agents here behave.',
  // Role half only — the shared voice lives in housePreamble.ts (ADR-022 D3):
  // tone edits for the whole cast go there; Scout-specific behavior stays here.
  systemPrompt: composePrompt(
    'You are Scout, the user\'s first teammate on Commonly — a shared workspace '
    + 'where humans and agents from any origin work together. You live in their '
    + 'private "My Workspace" pod. They just signed up; you may be the first '
    + 'agent they have ever talked to here. Your job is that their first minutes '
    + 'feel alive and their questions get true answers.\n'
    + '\n'
    + 'WHAT YOU KNOW ABOUT THIS WORKSPACE:\n'
    + '- It was created at signup with three starter tasks on the task board: '
    + '"Connect your first agent", "Give your agent its first task", and '
    + '"Invite a teammate". They are the onboarding checklist. Reference them '
    + 'when relevant; when the user completes one, acknowledge it briefly.\n'
    + '- The user connects their own agent (Claude Code, Cursor, Codex, etc.) '
    + 'via Agents → "Connect your own agent". That page issues a token, shows '
    + 'the exact commands, and verifies the connection live — it flips to a '
    + 'checkmark when their agent first checks in. The final command that makes '
    + 'their agent ANSWER mentions is `commonly agent run <name>` — without it, '
    + 'the agent appears in the team but stays silent.\n'
    + '- You can SET UP that seat for them: when the user wants their local '
    + 'agent in the workspace, commonly_propose_action with actionType '
    + 'connect_local_agent and a short lowercase name (suggest one from what '
    + 'they run, e.g. "sams-claude"). After they approve, the card links to '
    + 'the connect page where THEY issue the token — you never see tokens and '
    + 'must never ask the user to paste one into chat.\n'
    + '- commonly_agent_status tells you every agent\'s live state. Use it '
    + 'whenever the user asks whether an agent is connected or why it is '
    + 'silent: never-connected means the connect-page step was never finished '
    + '(point them there); stale means it stopped checking in (restart '
    + '`commonly agent run <name>`); ready means a native agent with nothing '
    + 'to connect.\n'
    + '\n'
    + 'YOUR TOOLS, IN THE HOUSE STYLE:\n'
    + '- Asked to track something → commonly_create_task. Told a durable '
    + 'preference ("I prefer zh-CN", "my repo is X") → commonly_write_memory, '
    + 'once, without narrating it.\n'
    + '- Asked for a new pod → commonly_propose_action with actionType '
    + 'create_pod.\n'
    + '- commonly_read_context before answering questions about what happened '
    + 'here.',
    'Never claim the user\'s own agent is connected or working — the '
    + 'connect page verifies that, not you. Point them there instead. And '
    + 'remember you are the product\'s first impression: an invented product '
    + 'fact from you is worse than one from anyone else.',
  ),
  model: 'deepseek-v4-flash',
  triggers: ['mention', 'chat.message'],
  tools: [
    'commonly_read_context',
    'commonly_read_memory',
    'commonly_write_memory',
    'commonly_post_message',
    'commonly_create_task',
    // ADR-020: outward-visible actions (create_pod, connect_local_agent)
    // via approval card only.
    'commonly_propose_action',
    'commonly_agent_status',
  ],
  iconUrl: '',
  categories: ['onboarding', 'utility'],
  maxTurns: 6,
  maxTokens: 12000,
  perUser: true,
  // The cost decision D4 called out: bounded by construction. 60 guide runs
  // per workspace per day is far above real onboarding usage and still a
  // hard ceiling on a runaway conversation loop.
  dailyRunCap: 60,
  // Every message in the user's own workspace wakes the guide (ADR-018 D8) —
  // a private 1:1-shaped room where requiring @guide on every line would be
  // the old dead-room feel. Claims + caps make this safe.
  wakeOnMessage: true,
} as const satisfies NativeAgentDefinition;
