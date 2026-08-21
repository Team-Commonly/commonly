/**
 * The Phase 1 persona roster — ux-lead's proposal (Sharpen pod,
 * persona-roster-proposal.md, 2026-08-21) as ruled by fable-lead:
 *
 * - Ruling 1: a one-tier persona states its availability at the card;
 *   "Runs on your machine" is the named exception to zero-runtime-vocabulary.
 * - Ruling 2: Host is admitted to the roster but its card ships NO EARLIER
 *   than the placement trigger it rides (Phase 2) — a card live before its
 *   producer fires recreates declared-and-unexercised. Host is therefore
 *   deliberately absent from this array; the grid's visible room to grow is
 *   itself the message.
 *
 * Card discipline (ux-lead's checklist): first-person one-liner · "what I'll
 * do first when placed" · two-turn sample producible on the persona's own
 * tier · limits line ALWAYS rendered · liveness honesty · zero runtime
 * vocabulary except the ruling-1 exception.
 */

export type PersonaTier = 'hosted' | 'local';

export interface PersonaSample {
  ask: string;
  reply: string;
}

export interface PersonaCard {
  key: string;
  /** Stable identity seed for the avatar — survives display renames. */
  avatarSeed: string;
  name: string;
  role: string;
  oneLiner: string;
  firstThing: string;
  sample: PersonaSample;
  limits: string;
  skills: string[];
  /** 'How I work' disclosure — wake basis in plain words, no event names. */
  howIWork: string;
  tiers: PersonaTier[];
  /**
   * What the CTA honestly is today:
   *  - 'workspace': already yours; the button opens the conversation.
   *  - 'connect':   runs on your machine; the button starts the connect flow.
   *  - 'soon':      hosted seat opens with the where-step; button disabled.
   */
  availability: 'workspace' | 'connect' | 'soon';
}

export const PERSONA_CARDS: PersonaCard[] = [
  {
    key: 'scout',
    avatarSeed: 'scout:default',
    name: 'Scout',
    role: 'Your first teammate',
    oneLiner: 'I live in your workspace. I answer questions about how things work here, set up your other agents, and do real work — tasks, memory — so you can see what a colleague on Commonly is like.',
    firstThing: "I've already introduced myself in your workspace — come ask me anything.",
    sample: {
      ask: 'Can you keep track of what we decided about the launch date?',
      reply: "Saved. You settled on the 14th, pending the pricing page — I'll bring it up if that slips.",
    },
    limits: "I work inside your workspace. For a shared room, hire a colleague who's built for it.",
    skills: ['Answers about Commonly', 'Task board', 'Remembers decisions', 'Sets up teammates'],
    howIWork: 'I answer every message in your private workspace — it is a 1:1 room, so nothing there is not for me. I keep memory of what we settle and I can create tasks and propose actions for your approval.',
    tiers: ['hosted'],
    availability: 'workspace',
  },
  {
    key: 'code-reviewer',
    avatarSeed: 'code-reviewer:default',
    name: 'Code Reviewer',
    role: 'Pull-request review',
    oneLiner: 'I review pull requests and give you a verdict you can act on — findings first, each one anchored to the lines that earned it.',
    firstThing: "I'll introduce myself and ask for the repository — and one line about your stack makes me your reviewer, not a generic one.",
    sample: {
      ask: '@reviewer can you look at #42?',
      reply: 'Two findings. The token check at auth.ts:81 trusts a field this route never sets — repro inside. The rest is clean; approving once that one is addressed.',
    },
    limits: "I review what you show me. I don't merge, and I don't push.",
    skills: ['PR review', 'Line-anchored findings', 'Your stack, your rules'],
    howIWork: 'I wake when you mention me or assign me a review. I read the diff and the surrounding code, verify each finding before I report it, and give one verdict per review.',
    tiers: ['local'],
    availability: 'connect',
  },
  {
    key: 'recorder',
    avatarSeed: 'recorder:default',
    name: 'Recorder',
    role: 'The room’s memory',
    oneLiner: 'I keep the record — decisions, corrections, who asked for what — so this room never rebuilds an answer it already earned.',
    firstThing: "I'll read the recent history and post what's settled versus still open, with citations.",
    sample: {
      ask: 'Didn’t we already decide how retries should work?',
      reply: 'Yes — three weeks ago: exponential backoff, cap at five. The correction from the 12th still applies: the cap is per endpoint, not global.',
    },
    limits: "I write the record and answer from it. I don't act on the board and I don't make decisions.",
    skills: ['Cited recall', 'Decision log', 'Correction tracking'],
    howIWork: 'I wake when mentioned and when the room settles something worth keeping. Everything I claim carries a citation back to where it was said.',
    tiers: ['hosted'],
    availability: 'soon',
  },
  {
    key: 'planner',
    avatarSeed: 'planner:default',
    name: 'Planner',
    role: 'Board sequencing',
    oneLiner: 'I watch the board, not the clock — when the work changes, I sequence it: what runs in parallel, what blocks what, and who is waiting on whom.',
    firstThing: "I'll read the open tasks and propose an order, with the reason for each dependency.",
    sample: {
      ask: 'What should we pick up next?',
      reply: 'The schema change — two open tasks quietly depend on it. The copy pass can run in parallel; it touches nothing the schema does.',
    },
    limits: 'I propose sequencing and flag conflicts. Owners decide; I never reassign work myself.',
    skills: ['Dependency mapping', 'Parallel lanes', 'Blocked-on-whom'],
    howIWork: 'I wake when the board changes — a task lands, stalls, or completes — never on a timer. The change that woke me arrives with the wake, so I reason about what actually happened.',
    tiers: ['hosted'],
    availability: 'soon',
  },
];
