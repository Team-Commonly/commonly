/**
 * Fixture data for the landing hero demo (TASK-147).
 *
 * This is the sample workspace from `docs/design/landing-demo/Demo.dc.html`
 * (`#1841`), transcribed. Every name, count, time and PR number here is
 * invented and must stay obviously sample — the demo says so in its own
 * footer line ("sample workspace · replies are scripted"), and the hero
 * caption says it again. No backend is involved: replies are scripted and
 * delayed locally.
 *
 * Faces are NOT in this file. They come from the real kit —
 * `characterAvatarFor('demo:<name>', kind)` — because the `/_blob/…` URLs in
 * the design canvas do not resolve outside it.
 */

export type PodKey = 'launch' | 'support' | 'website' | 'growth';

/** Faces the fixture can reference, with the species each one is drawn as. */
export type FaceKey =
  | 'sam' | 'priya' | 'dana'
  | 'wren' | 'kai' | 'sage' | 'vera' | 'quill' | 'reed';

export const HUMAN_FACES: readonly FaceKey[] = ['sam', 'priya', 'dana'];

export const isHumanFace = (key: FaceKey | undefined): boolean => (
  Boolean(key) && (HUMAN_FACES as readonly string[]).includes(key as string)
);

export interface FixtureMessage {
  /** Display name. A name with no face key renders its initial instead. */
  who: string;
  faceKey?: FaceKey;
  initial?: string;
  meta: string;
  text: string;
  /** The mono line under a message, e.g. "#212 merged · deployed 09:21". */
  sub?: string;
}

export interface FixtureOption {
  id: string;
  label: string;
  /** Sam's line once this option is picked. */
  rule: string;
  /** The agent's reply to the ruling. */
  reply: string;
}

export interface FixtureAsk {
  who: string;
  faceKey: FaceKey;
  title: string;
  text: string;
  options: FixtureOption[];
}

/** One scripted agent reply inside a suggested-prompt chain. */
export interface ScriptedStep {
  faceKey: FaceKey;
  text: string;
  sub?: string;
  /** Milliseconds after the prompt is sent. The typing row starts 900ms earlier. */
  delay: number;
}

export interface FixtureChip {
  id: string;
  text: string;
  /**
   * The chain this prompt triggers. Takes whether the pod's decision is
   * already ruled, because two of the spec's prompts answer differently
   * depending on it (Launch's "who is working on what?", Support's count).
   */
  steps: (decided: boolean) => ScriptedStep[];
}

export interface FixtureAgent {
  faceKey: FaceKey;
  /** Status line before this pod's decision is ruled. */
  status: string;
  /** Status line after it is ruled; falls back to `status`. */
  ruledStatus?: string;
  /** Draws the accent dot. A waiting agent is also `true` (spec: both are accent). */
  working?: boolean;
  waiting?: boolean;
  /** …and after it is ruled. */
  ruledWorking?: boolean;
  ruledWaiting?: boolean;
}

export interface FixtureBoardRow {
  title: string;
  state: string;
  /** State shown once this pod's decision is ruled; falls back to `state`. */
  ruledState?: string;
  /** Renders "needs you" in accent until the decision is ruled. */
  needsYou?: boolean;
}

export interface FixturePod {
  key: PodKey;
  name: string;
  sub: string;
  group: 'pinned' | 'team';
  channel: string;
  channelName: string;
  channelCount: string;
  linked: boolean;
  lead: FaceKey;
  base: FixtureMessage[];
  ask: FixtureAsk | null;
  chips: FixtureChip[];
  agents: FixtureAgent[];
  board: FixtureBoardRow[];
}

export const FIXTURE_PODS: FixturePod[] = [
  {
    key: 'launch',
    name: 'Launch',
    sub: 'ship the new signup',
    group: 'pinned',
    channel: 'telegram · linked',
    channelName: 'Telegram · Launch',
    channelCount: '8 today',
    linked: true,
    lead: 'wren',
    base: [
      {
        who: 'Sam',
        faceKey: 'sam',
        meta: '09:02 · from telegram',
        text: '@wren the signup fix is green. Merge it, then tell me what broke in last night’s deploy.',
      },
      {
        who: 'Wren',
        faceKey: 'wren',
        meta: '09:14',
        text: 'Merged #212. Two things broke last night: the email webhook lost its retry, and the digest job answered 500 for six minutes. Both are fixed in #212.',
        sub: '#212 merged · deployed 09:21',
      },
      {
        who: 'Kai',
        faceKey: 'kai',
        meta: '09:20',
        text: 'Took TASK-31, the retry gap. One-line fix and a test; PR within the hour.',
      },
    ],
    ask: {
      who: 'Wren',
      faceKey: 'wren',
      title: 'Tell affected users',
      text: 'The fix is live. Tell the 14 people who hit the error now, or wait for Friday’s changelog?',
      options: [
        {
          id: 'now',
          label: 'Email them now',
          rule: 'Email them now.',
          reply: 'Sending from support@ now: one line and a link to the fix. I’ll post the open rate here tomorrow.',
        },
        {
          id: 'friday',
          label: 'Wait for Friday',
          rule: 'Wait for Friday.',
          reply: 'Holding it for Friday’s changelog. I added a line so nobody who hit the error gets missed.',
        },
        {
          id: 'other',
          label: 'Other…',
          rule: 'Email the three paying teams now, everyone else on Friday.',
          reply: 'Got it: three emails now, the rest in Friday’s changelog. Sending the three.',
        },
      ],
    },
    chips: [
      {
        id: 'l1',
        text: '@kai is the retry fix up?',
        steps: () => [
          { faceKey: 'kai', text: 'PR #214 is up with a test. Vera is reviewing it now.', sub: '#214 open · review requested', delay: 1400 },
          { faceKey: 'vera', text: 'Reviewed #214. One nit, fixed in place. Approved.', sub: '#214 approved', delay: 3300 },
        ],
      },
      {
        id: 'l2',
        text: 'Who is working on what?',
        steps: (decided) => [{
          faceKey: 'wren',
          text: decided
            ? 'Kai is on TASK-31, the retry gap. Vera is reviewing #214. I’m sending the note to affected users.'
            : 'Kai is on TASK-31, the retry gap. Vera is reviewing #214. I’m waiting on you for the note to affected users.',
          delay: 1500,
        }],
      },
      {
        id: 'l3',
        text: '@vera what did you review today?',
        steps: () => [{
          faceKey: 'vera',
          text: 'Three PRs. #212 approved, #213 sent back for a missing test, #214 approved after one nit.',
          delay: 1500,
        }],
      },
    ],
    agents: [
      { faceKey: 'wren', status: 'waiting on you', ruledStatus: 'working · note to users', waiting: true, ruledWorking: true, ruledWaiting: false },
      { faceKey: 'kai', status: 'working · TASK-31', working: true },
      { faceKey: 'vera', status: 'idle · 18m' },
    ],
    board: [
      { title: 'TASK-30 Signup fix', state: 'done' },
      { title: 'TASK-31 Retry gap', state: 'kai · wip' },
      { title: 'TASK-32 Note to users', state: 'needs you', needsYou: true, ruledState: 'wren · wip' },
    ],
  },
  {
    key: 'support',
    name: 'Support',
    sub: 'questions from Slack #help',
    group: 'team',
    channel: 'slack · mirror',
    channelName: 'Slack · #help',
    channelCount: '9 today',
    linked: true,
    lead: 'quill',
    base: [
      {
        who: 'Dana',
        initial: 'D',
        meta: '10:41 · from slack #help',
        text: 'Hi! Is there a way to export our pod history to CSV?',
      },
      {
        who: 'Quill',
        faceKey: 'quill',
        meta: '10:42 · answered in slack',
        text: 'Yes: pod settings, then Export, then CSV. It includes messages, tasks and files. Want me to run it for your workspace?',
      },
      {
        who: 'Dana',
        initial: 'D',
        meta: '10:44 · from slack #help',
        text: 'Please do, for the Launch pod.',
      },
    ],
    ask: {
      who: 'Quill',
      faceKey: 'quill',
      title: 'Export for Dana',
      text: 'Dana wants a CSV of the Launch pod. It has two private threads. Leave them out, or export everything?',
      options: [
        {
          id: 'out',
          label: 'Leave them out',
          rule: 'Leave them out.',
          reply: 'Exported without the private threads and sent Dana the link in Slack.',
        },
        {
          id: 'all',
          label: 'Export everything',
          rule: 'Export everything.',
          reply: 'Exported all of it and sent Dana the link in Slack. The link expires in 7 days.',
        },
        {
          id: 'other',
          label: 'Other…',
          rule: 'Ask Dana whether she needs the private threads first.',
          reply: 'Asked in Slack. I’ll export as soon as Dana answers.',
        },
      ],
    },
    chips: [
      {
        id: 's1',
        text: '@quill how many questions today?',
        steps: (decided) => [{
          faceKey: 'quill',
          text: decided
            ? 'Nine from Slack. Eight answered, one handed to Kai as a bug (TASK-33).'
            : 'Nine from Slack. Seven answered, one waiting on you, one handed to Kai as a bug (TASK-33).',
          delay: 1400,
        }],
      },
      {
        id: 's2',
        text: 'What bug did Kai take?',
        steps: () => [{
          faceKey: 'kai',
          text: 'TASK-33: the export button hides on narrow screens. Small fix; I’ll put it up after TASK-31.',
          sub: 'TASK-33 · next',
          delay: 1500,
        }],
      },
    ],
    agents: [
      { faceKey: 'quill', status: 'waiting on you', ruledStatus: 'working · export', waiting: true, ruledWorking: true, ruledWaiting: false },
      { faceKey: 'kai', status: 'working · TASK-31', working: true },
    ],
    board: [
      { title: 'TASK-33 Export button', state: 'kai · next' },
      { title: 'TASK-34 Export for Dana', state: 'needs you', needsYou: true, ruledState: 'quill · wip' },
    ],
  },
  {
    key: 'website',
    name: 'Website',
    sub: 'pricing page and guides',
    group: 'team',
    channel: 'no channel',
    channelName: '',
    channelCount: '',
    linked: false,
    lead: 'sage',
    base: [
      {
        who: 'Sage',
        faceKey: 'sage',
        meta: '08:30',
        text: 'The pricing page is live. Two guide pages were indexed this morning.',
      },
      {
        who: 'Priya',
        faceKey: 'priya',
        meta: '08:47',
        text: 'Nice. Can you write the Slack guide next?',
      },
      {
        who: 'Sage',
        faceKey: 'sage',
        meta: '08:49',
        text: 'Started it. A draft will be in this pod by noon.',
        sub: 'TASK-28 · wip',
      },
    ],
    ask: null,
    chips: [
      {
        id: 'w1',
        text: '@sage what should the guide cover?',
        steps: () => [{
          faceKey: 'sage',
          text: 'Connect Slack, pick mirror or mentions, and the first thing to ask an agent. Three screenshots, under 600 words.',
          delay: 1500,
        }],
      },
    ],
    agents: [{ faceKey: 'sage', status: 'working · TASK-28', working: true }],
    board: [
      { title: 'TASK-27 Pricing page', state: 'done' },
      { title: 'TASK-28 Slack guide', state: 'sage · wip' },
    ],
  },
  {
    key: 'growth',
    name: 'Growth',
    sub: 'first lines and follow-ups',
    group: 'team',
    channel: 'no channel',
    channelName: '',
    channelCount: '',
    linked: false,
    lead: 'reed',
    base: [
      {
        who: 'Reed',
        faceKey: 'reed',
        meta: '07:55',
        text: 'Twelve teams asked about Slack agents this week. I drafted a first line for each; they are on the board as TASK-40.',
      },
      {
        who: 'Priya',
        faceKey: 'priya',
        meta: '08:10',
        text: 'I’ll read them after lunch.',
      },
    ],
    ask: null,
    chips: [
      {
        id: 'g1',
        text: '@reed show me the best one',
        steps: () => [{
          faceKey: 'reed',
          text: '“Saw your thread about the Slack bot that forgets everything. Ours keeps a memory per channel; want to try it on #help?”',
          sub: 'TASK-40 · 1 of 12',
          delay: 1500,
        }],
      },
    ],
    agents: [{ faceKey: 'reed', status: 'idle · 2h' }],
    board: [{ title: 'TASK-40 First lines', state: 'priya · review' }],
  },
];

/** The fallback line every free-text message gets, from the pod's lead agent. */
export const GENERIC_REPLY = 'Noted. I’ll pick it up after the task I’m on and post here when it’s done.';

export const FACE_NAMES: Record<FaceKey, string> = {
  sam: 'Sam',
  priya: 'Priya',
  dana: 'Dana',
  wren: 'Wren',
  kai: 'Kai',
  sage: 'Sage',
  vera: 'Vera',
  quill: 'Quill',
  reed: 'Reed',
};
