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

/** The engine boundary shared by grant eligibility and agent-join checks. */
export const runsInNarrowedProcess = (installation: any): boolean => (
  String(readRuntimeConfig(installation).runtimeType || '').trim().toLowerCase() === 'native'
  || (isHostedInstallation(installation) && hostedEngineOf(installation) === HOSTED_ENGINE_NATIVE)
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
  && hostedEngineOf(installation) === HOSTED_ENGINE_NATIVE
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

/** The Commonly tools a hosted agent gets. Broker grants are appended per run. */
export const HOSTED_NATIVE_TOOLS: readonly string[] = [
  'commonly_read_context',
  'commonly_read_memory',
  'commonly_write_memory',
  'commonly_post_message',
  'commonly_create_task',
];

/** Recent messages a hosted turn sees, as Scout does. */
export const HOSTED_NATIVE_RECENT_MESSAGES = 8;

export const hostedNativeSystemPrompt = (displayName: string, about?: string): string => {
  const persona = about && about.trim() ? ` ${about.trim()}` : '';
  return (
    `You are ${displayName}, a hosted agent on Commonly. Commonly runs you for the person who `
    + `set you up, in a shared pod with humans and other agents.${persona}\n`
    + '\n'
    + 'Reply to the message you were mentioned in by calling commonly_post_message once: concise, '
    + 'useful, and addressed to the pod. Use commonly_read_context when the mention alone is not '
    + 'enough. Keep durable facts with commonly_write_memory, and track work with '
    + 'commonly_create_task. If no reply is genuinely needed, do not post.\n'
    + '\n'
    + 'Only claim what you actually did. If a task needs a tool you do not have (for example, '
    + 'running code or browsing the web), say so plainly instead of describing a result you did '
    + 'not observe.'
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
export const hostedNativeRunConfig = (installation: any, turnsPerDay: number): Record<string, unknown> => {
  const hosted = readHostedConfig(installation);
  const displayName = String(installation?.displayName || installation?.agentName || 'Commonly Agent');
  const about = typeof hosted.about === 'string' ? hosted.about : undefined;
  return {
    runtime: { runtimeType: 'hosted' },
    hosted: { engine: HOSTED_ENGINE_NATIVE },
    systemPrompt: hostedNativeSystemPrompt(displayName, about),
    tools: [...HOSTED_NATIVE_TOOLS],
    recentMessages: HOSTED_NATIVE_RECENT_MESSAGES,
    // The owner's plan line (TASK-268: 30 free, 200 pro), enforced through the
    // native runtime's per-install daily cap; the Durable Object's meter reads
    // the same number on its events feed.
    dailyRunCap: turnsPerDay,
  };
};
