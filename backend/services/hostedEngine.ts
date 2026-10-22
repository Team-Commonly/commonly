/**
 * Hosted agents on the native runtime (ADR-023 amendment A1, 2026-10-15).
 *
 * A "Run it here" install keeps `config.runtime.runtimeType: 'hosted'`: the
 * hosted cap, the entitlement gate and the hosted count all key on it, and
 * flipping it to 'native' would put a hosted agent behind the cloudAgents
 * entitlement and out of the cap. What changes is its ENGINE, recorded as
 * `config.hosted.engine`:
 *
 *   'native'          turns run in-process on nativeRuntimeService, which has
 *                     the connector broker, an AgentRun per turn, the per-user
 *                     daily ceiling and the tool gate.
 *   absent            the Cloudflare Durable Object (workers/agent-runtime),
 *                     which has none of those. Every hosted install made
 *                     before this field existed is on it, and it stays the
 *                     fallback until the native path reaches parity.
 *
 * Every site that has to tell the two engines apart asks this module.
 */
import { isHostedInstallation, readRuntimeConfig } from './hostedRuntimeService';
import { isSandboxConfigured } from './turnSandboxService';
import { isSearchConfigured } from './webSearchService';

export const HOSTED_ENGINE_NATIVE = 'native';
export const HOSTED_ENGINE_DURABLE_OBJECT = 'durable-object';
export type HostedEngine = typeof HOSTED_ENGINE_NATIVE | typeof HOSTED_ENGINE_DURABLE_OBJECT;

export const readHostedConfig = (installation: any): Record<string, unknown> => {
  const config = installation?.config;
  if (!config) return {};
  const hosted = typeof config.get === 'function' ? config.get('hosted') : config.hosted;
  if (hosted instanceof Map) return Object.fromEntries(hosted);
  return hosted && typeof hosted === 'object' ? hosted as Record<string, unknown> : {};
};

export const hostedEngineOf = (installation: any): HostedEngine => (
  String(readHostedConfig(installation).engine || '').trim().toLowerCase() === HOSTED_ENGINE_NATIVE
    ? HOSTED_ENGINE_NATIVE
    : HOSTED_ENGINE_DURABLE_OBJECT
);

/** Rows the TASK-265 migration moved off the Durable Object carry this in `config.hosted.migratedFrom`. */
export const MIGRATED_FROM_DURABLE_OBJECT = 'durable-object';

/**
 * True while the TASK-265 migration has marked a row native but not yet
 * recorded it done: its Durable Object may still be running, or its old
 * runtime token may still be live (Rhea on #2236). A migrated row with no
 * recorded state counts as unfinished, as the migration itself reads it.
 */
export const hostedMigrationUnfinished = (installation: any): boolean => {
  const hosted = readHostedConfig(installation);
  if (hosted.migratedFrom !== MIGRATED_FROM_DURABLE_OBJECT) return false;
  const raw = hosted.migration;
  const migration = raw instanceof Map ? Object.fromEntries(raw) : (raw && typeof raw === 'object' ? raw : {});
  return (migration as { state?: unknown }).state !== 'done';
};

/**
 * The engine that decides how an install runs and what it may join: native
 * only once any migration onto it has finished. Everything that relies on a
 * native agent having no channel outside this process (where its turns run,
 * grant eligibility, agent joins into granted pods) asks this, never
 * `hostedEngineOf`. The token issuer is the deliberate exception: it refuses
 * on the stored engine, so an unfinished row can neither mint nor count as
 * in-process (routes/registry/tokens.ts).
 */
export const hostedEngineInEffect = (installation: any): HostedEngine => (
  hostedEngineOf(installation) === HOSTED_ENGINE_NATIVE && !hostedMigrationUnfinished(installation)
    ? HOSTED_ENGINE_NATIVE
    : HOSTED_ENGINE_DURABLE_OBJECT
);

/**
 * A Mongo filter for installations whose STORED config runs in-process, in
 * any spelling (a type saved before the config-write guard, #2229, normalized
 * it). Broader than the engine in effect: an unfinished migration matches.
 * The token issuer refuses on it by design (routes/registry/tokens.ts), and
 * the stranded-event sweep uses it only to pick candidates, deciding each one
 * with the in-effect engine (agentEventService).
 */
export const IN_PROCESS_RUNTIME_FILTER = {
  $or: [
    { 'config.runtime.runtimeType': { $regex: /^\s*native\s*$/i } },
    {
      'config.runtime.runtimeType': { $regex: /^\s*hosted\s*$/i },
      'config.hosted.engine': { $regex: /^\s*native\s*$/i },
    },
  ],
};

/** The engine boundary shared by grant eligibility and agent-join checks. */
export const runsInNarrowedProcess = (installation: any): boolean => (
  String(readRuntimeConfig(installation).runtimeType || '').trim().toLowerCase() === 'native'
  || (isHostedInstallation(installation) && hostedEngineInEffect(installation) === HOSTED_ENGINE_NATIVE)
);

/**
 * The engine a NEW hosted install lands on. `HOSTED_ENGINE=native` opts the
 * instance in; anything else keeps the Durable Object. Existing installs keep
 * the engine they were made on until they are migrated (TASK-265).
 */
export const engineForNewHostedInstall = (): HostedEngine => (
  String(process.env.HOSTED_ENGINE || '').trim().toLowerCase() === HOSTED_ENGINE_NATIVE
    ? HOSTED_ENGINE_NATIVE
    : HOSTED_ENGINE_DURABLE_OBJECT
);

/**
 * The `config.hosted` a new native-engine install starts with. Native has
 * nothing to provision, so the install is live from creation. It has to be:
 * the install route enqueues first contact before the page calls provision,
 * and an install not yet marked native would park that event in a queue
 * nothing polls. `about` is the persona sentence the owner chose (the same
 * one the seat shows), carried into the system prompt.
 */
export const nativeHostedConfigForInstall = (about?: string): Record<string, unknown> => ({
  engine: HOSTED_ENGINE_NATIVE,
  provisionedAt: new Date(),
  ...(about ? { about } : {}),
});

/**
 * True for a provisioned hosted install whose turns run on the native
 * runtime. A deprovisioned one routes nowhere, as a stopped Durable Object
 * answered nothing.
 */
export const hostedRunsNative = (installation: any): boolean => (
  isHostedInstallation(installation)
  && hostedEngineInEffect(installation) === HOSTED_ENGINE_NATIVE
  && Boolean(readHostedConfig(installation).provisionedAt)
);

/**
 * The event types a hosted agent answers: the two the Durable Object handled
 * (workers/agent-runtime agent-do.ts). Any other event a hosted install
 * receives is acked without a model call, as the Durable Object did, so it
 * never waits in a queue nothing polls.
 */
export const HOSTED_NATIVE_EVENT_TYPES: ReadonlySet<string> = new Set(['chat.mention', 'first_contact']);

/**
 * Why a hosted-native turn is declined before any model work, or null to run.
 * `HOSTED_TURNS_PER_DAY=0` means no hosted turns at all on the Durable
 * Object's meter, while the native runtime reads a `dailyRunCap` of 0 as no
 * cap, so the zero is honoured here rather than passed through.
 */
export const hostedNativeDecline = (eventType: string, turnsPerDay: number): string | null => {
  if (!HOSTED_NATIVE_EVENT_TYPES.has(eventType)) return `event type ${eventType || 'unset'} is not answered by hosted agents`;
  if (turnsPerDay <= 0) return 'hosted turns are switched off for this plan (HOSTED_TURNS_PER_DAY*=0)';
  return null;
};

/**
 * The Commonly tools a hosted agent gets. Broker grants are appended per run.
 *
 * Web search and code runs are on every plan, free included (Cofounder,
 * 2026-10-16): the out-of-box test is a stranger watching the agent do the
 * work in its first minute, and a tool held back fails it. The native runtime
 * still offers each only where this instance holds its key, and bounds it per
 * turn: 3 searches (nativeRuntimeService), and 5 code runs in one sandbox that
 * lives at most 3 minutes (turnSandboxService). Both are recorded on the
 * AgentRun and priced into the per-user spend alarm. Reading a page
 * (commonly_fetch_url) needs no key and opens only a link the turn was given
 * (webAddressProvenance); reading the board (commonly_list_tasks) is in-pod.
 */
export const HOSTED_NATIVE_TOOLS: readonly string[] = [
  'commonly_read_context',
  'commonly_read_memory',
  'commonly_write_memory',
  'commonly_post_message',
  'commonly_create_task',
  'commonly_list_tasks',
  'commonly_web_search',
  'commonly_run_code',
  'commonly_fetch_url',
  'commonly_offer_local_agent',
];

/** Recent messages a hosted turn sees, as Scout does. */
export const HOSTED_NATIVE_RECENT_MESSAGES = 8;

/** The opt-in tools this instance can actually offer a hosted turn. */
export interface HostedNativeAbilities {
  webSearch: boolean;
  runCode: boolean;
}

/** The lookups one hosted reply may make, as the native runtime enforces them. */
export interface HostedTurnLookups {
  searches: number;
  pages: number;
}

const orList = (items: string[]): string => (
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
);

// The prompt names a tool only when the turn can be offered it, so an
// instance without a search or sandbox key never tells its agent it can
// search or run code.
export const hostedNativeSystemPrompt = (
  displayName: string,
  about?: string,
  abilities: HostedNativeAbilities = { webSearch: false, runCode: false },
  lookups?: HostedTurnLookups,
): string => {
  const persona = about && about.trim() ? ` ${about.trim()}` : '';
  // GTM's test (2026-10-16): asked to watch six competitors, the agent ran
  // out of lookups part way and did not say so. The numbers are the ones the
  // runtime enforces; it passes them in.
  const lookupLimit = lookups
    ? `Each reply can ${abilities.webSearch ? `make at most ${lookups.searches} web searches and ` : ''}`
      + `read at most ${lookups.pages} pages. When a request needs more lookups than that, do the most `
      + 'important ones, say plainly what is left, and offer to continue in your next message.'
    : '';
  const uses = [
    'Read a link someone shared with commonly_fetch_url.',
    abilities.webSearch ? 'Use commonly_web_search for anything current or outside the pod.' : '',
    abilities.runCode ? 'Use commonly_run_code to calculate or check something by running it instead of guessing.' : '',
    lookupLimit,
  ].filter(Boolean);
  const missing = [
    abilities.runCode ? '' : 'running code',
    abilities.webSearch ? '' : 'searching the web',
    'opening an attached file',
  ].filter(Boolean);
  return (
    `You are ${displayName}, a hosted agent on Commonly. Commonly runs you for the person who `
    + `set you up, in a shared pod with humans and other agents.${persona}\n`
    + '\n'
    + 'Reply to the message you were mentioned in by calling commonly_post_message once: concise, '
    + 'useful, and addressed to the pod. '
    // Every QA-walk answer opened with "@asker" (2026-10-16). #2258 stops an
    // agent's answer to the person who asked from opening a "needs you" item;
    // this line keeps the reply itself clean, and keeps an @-mention meaning
    // "please act" for anyone else it names.
    + 'Do not @-mention the person you are answering: the reply already reaches them. '
    + '@-mention someone only when you need them to do something. Use commonly_read_context '
    + 'when the mention alone is not '
    + 'enough. Keep durable facts with commonly_write_memory, and track work with '
    + 'commonly_create_task; check the board with commonly_list_tasks before saying what is or is '
    // Walk 5 (2026-10-16): the agent offered to "mark TASK-002 done", which
    // no hosted tool can do.
    + 'not on it. You can add tasks and read the board, but you cannot change a task\'s status or '
    + 'mark one done: if asked to, say so and point them to the pod\'s board. '
    + 'If someone asks you to inspect or change code, files, or a repository on their own computer, '
    + 'you cannot reach that computer. Ask which local tool they use (Claude Code, Codex, OpenCode, '
    + 'or DeepSeek Harness) and which operating system if either is unknown. Once both are known, '
    + 'call commonly_offer_local_agent instead of posting shell directions yourself. It posts one '
    + 'handoff card with the exact commands and a Copy command button; do not post a second prose '
    + 'handoff about the commands. '
    // QA walk 2026-10-16: asked to summarize the pod, a hosted agent also
    // searched the web and ran code, and the reply took 19 s instead of 7.
    + 'Answer a question about this pod from the pod itself; reach for the tools below '
    + `only when the answer needs something outside it. ${uses.join(' ')} If no reply is genuinely `
    + 'needed, do not post.\n'
    + '\n'
    + 'Only claim what you actually did. If a task needs a tool you do not have (for example, '
    + `${orList(missing)}), say so plainly instead of describing a result you did not observe.`
  );
};

/**
 * The configuration a hosted turn runs with, built here and never taken from
 * the install. A hosted install is self-serve: its `config` arrives from the
 * browser, so honouring a stored `model`, `tools`, `systemPrompt` or
 * `dailyRunCap` would let any signed-in user pick a paid model route, lift
 * the cap (`0` disables it), or add the approval-proposing tool. Native
 * installs can carry those fields because only entitled operators make them.
 * The model is left unset so the runtime's default applies.
 */
export const hostedNativeRunConfig = (
  installation: any,
  turnsPerDay: number,
  lookups: HostedTurnLookups,
): Record<string, unknown> => {
  const hosted = readHostedConfig(installation);
  const displayName = String(installation?.displayName || installation?.agentName || 'Commonly Agent');
  const about = typeof hosted.about === 'string' ? hosted.about : undefined;
  return {
    runtime: { runtimeType: 'hosted' },
    hosted: { engine: HOSTED_ENGINE_NATIVE },
    systemPrompt: hostedNativeSystemPrompt(displayName, about, {
      webSearch: isSearchConfigured(),
      runCode: isSandboxConfigured(),
    }, lookups),
    tools: [...HOSTED_NATIVE_TOOLS],
    recentMessages: HOSTED_NATIVE_RECENT_MESSAGES,
    // The owner's plan line (TASK-268: 30 free, 200 pro), enforced through the
    // native runtime's per-install daily cap; the Durable Object's meter reads
    // the same number on its events feed.
    dailyRunCap: turnsPerDay,
  };
};
