/**
 * commonly agent <subcommand>
 *
 * register   — register a webhook agent against an instance
 * connect    — local dev loop: poll events → forward to localhost
 * attach     — wrap a local CLI as a Commonly agent (ADR-005)
 * run        — poll events, spawn the wrapped CLI, post results (ADR-005)
 * init       — scaffold a webhook-SDK agent in the current dir (ADR-006)
 * list       — list installed agents
 * logs       — stream recent events for an agent
 * heartbeat  — manually trigger an agent's heartbeat
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'fs';
import { join, dirname, resolve as pathResolve } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { createClient } from '../lib/api.js';
import { getToken, resolveInstanceUrl } from '../lib/config.js';
import { startPoller } from '../lib/poller.js';
import { startWebhookServer, forwardToLocalWebhook } from '../lib/webhook-server.js';
import { getAdapter, listAdapterNames } from '../lib/adapters/index.js';
import {
  getSession,
  setSession,
  clearSessions,
  wasEventHandled,
  recordHandledEvent,
} from '../lib/session-store.js';
import { readLongTerm, syncBack } from '../lib/memory-bridge.js';
import { pollRetryPolicy } from '../lib/poll-retry.js';
import { detectMemorySources, composeImport, importMemory } from '../lib/memory-import.js';
import { detectSkills, importSkills } from '../lib/skills-import.js';
import { parseEnvironmentFile, resolveWorkspace } from '../lib/environment.js';
import { detectBwrap } from '../lib/sandbox/bwrap.js';
import { detectSeatbelt } from '../lib/sandbox/seatbelt.js';
import {
  formatRetryDelay,
  spawnRetryJitter,
  spawnRetryPolicy,
} from '../lib/spawn-retry.js';
import {
  ADDRESSED_EVENT_TYPES,
  CASCADE_DEFAULTS,
  CASCADE_ENV_VARS,
  CLAIMABLE_EVENT_TYPES,
  classifyTrigger,
  createCascadeGovernor,
  createClaimHandicap,
  createClaimKeeper,
  deliverChatReply,
  peerHoldsFrame,
  resolveCascadeSettings,
} from '../lib/enforcement.js';

// ── Token file I/O — ~/.commonly/tokens/<name>.json (ADR-005) ───────────────

const tokensDir = () => join(homedir(), '.commonly', 'tokens');
const tokenFile = (name) => join(tokensDir(), `${name}.json`);

export const saveAgentToken = (name, record) => {
  if (!existsSync(tokensDir())) mkdirSync(tokensDir(), { recursive: true });
  // mode applies on create only — the record carries a live cm_agent_* secret,
  // same handling as performInit's .commonly-env.
  writeFileSync(
    tokenFile(name),
    JSON.stringify({ ...record, savedAt: new Date().toISOString() }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
};

export const loadAgentToken = (name) => {
  const file = tokenFile(name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export const deleteAgentToken = (name) => {
  const file = tokenFile(name);
  if (existsSync(file)) rmSync(file);
};

// ── env-var bootstrap for `agent run` (#913) ────────────────────────────────
// The BYO connect page hands a fresh user two env exports and
// `commonly agent run <name>` — on a machine that has never run
// `commonly agent attach`, so no token file exists and run used to dead-end.
// The runtime token IS the identity: everything else in the record either
// comes from `GET /api/agents/runtime/installations` (agentName, instanceId,
// podId) or is a local fact (which CLI binary to wrap). Returns a record ready
// for saveAgentToken, or null when COMMONLY_AGENT_TOKEN isn't set (caller
// falls back to the attach hint).
export const BOOTSTRAP_ADAPTER_DETECT_ORDER = ['claude', 'codex'];

export const bootstrapAgentRecordFromEnv = async ({
  name,
  env = process.env,
  clientFactory = createClient,
  adapterRegistry = { getAdapter, listAdapterNames },
  adapterOverride = null,
  log = () => {},
}) => {
  const runtimeToken = (env.COMMONLY_AGENT_TOKEN || '').trim();
  if (!runtimeToken) return null;
  if (!runtimeToken.startsWith('cm_agent_')) {
    throw new Error('COMMONLY_AGENT_TOKEN is set but is not a runtime token (expected cm_agent_… prefix).');
  }
  const instanceUrl = (env.COMMONLY_API_URL || '').trim() || resolveInstanceUrl(undefined);

  let identity;
  try {
    identity = await clientFactory({ instance: instanceUrl, token: runtimeToken })
      .get('/api/agents/runtime/installations');
  } catch (err) {
    throw new Error(
      `Could not resolve the agent behind COMMONLY_AGENT_TOKEN against ${instanceUrl}: ${err.message}. `
      + 'Check the token was copied whole and the URL matches the instance that issued it.',
    );
  }

  const installs = Array.isArray(identity?.installations) ? identity.installations : [];
  const primary = installs.find((i) => i.type === 'installation' && i.status === 'active')
    || installs[0] || null;

  // The adapter names a binary on THIS machine — the one fact the server
  // cannot know. Explicit --adapter wins; otherwise probe the known CLIs.
  let adapterName = adapterOverride;
  if (adapterOverride) {
    const adapter = adapterRegistry.getAdapter(adapterOverride);
    if (!adapter) {
      throw new Error(`Unknown adapter '${adapterOverride}'. Known: ${adapterRegistry.listAdapterNames().join(', ')}`);
    }
    if (!await adapter.detect()) {
      throw new Error(`Adapter '${adapterOverride}' not found on PATH.`);
    }
  } else {
    for (const candidate of BOOTSTRAP_ADAPTER_DETECT_ORDER) {
      const adapter = adapterRegistry.getAdapter(candidate);
      // eslint-disable-next-line no-await-in-loop
      if (adapter && await adapter.detect()) { adapterName = candidate; break; }
    }
    if (!adapterName) {
      throw new Error(
        `No supported agent CLI found on PATH (looked for: ${BOOTSTRAP_ADAPTER_DETECT_ORDER.join(', ')}). `
        + 'Install one, or pass --adapter <name>.',
      );
    }
  }

  // The token's identity wins over the CLI argument — a mistyped name must
  // not fork a second identity for the same token.
  const agentName = identity?.agentName || name;
  if (String(agentName).toLowerCase() !== String(name).toLowerCase()) {
    log(`token belongs to '${agentName}', not '${name}' — using the token's identity`);
  }

  return {
    agentName,
    instanceId: identity?.instanceId || primary?.instanceId || 'default',
    podId: primary?.podId || null,
    instanceUrl,
    runtimeToken,
    adapter: adapterName,
    environment: buildDefaultEnvironment(adapterName),
    workspacePath: null,
  };
};

/**
 * Enumerate every agent attached on this laptop — i.e. every file in
 * ~/.commonly/tokens/*.json. Cross-references the session store for a
 * "last turn" timestamp per agent so the user sees cold vs. live agents.
 *
 * Returns an array of plain records so the CLI table formatter stays simple
 * and tests can assert on shape directly.
 */
export const listLocalAgents = () => {
  const dir = tokensDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .map((name) => {
      const record = loadAgentToken(name);
      if (!record) return null;
      let lastTurn = null;
      try {
        const sessionsFile = join(homedir(), '.commonly', 'sessions', `${name}.json`);
        if (existsSync(sessionsFile)) {
          const sessions = JSON.parse(readFileSync(sessionsFile, 'utf8'));
          // One entry per pod — we surface the most recent across pods.
          Object.values(sessions).forEach((s) => {
            if (s?.lastTurn && (!lastTurn || s.lastTurn > lastTurn)) lastTurn = s.lastTurn;
          });
        }
      } catch {
        // Corrupt session store — not a hard error, just skip.
      }
      return {
        name,
        adapter: record.adapter || '?',
        podId: record.podId || '?',
        instanceUrl: record.instanceUrl || '?',
        instanceId: record.instanceId || 'default',
        savedAt: record.savedAt || null,
        lastTurn,
      };
    })
    .filter(Boolean);
};

// Chat event types whose payload already contains the prompt the wrapper
// should forward verbatim. Heartbeat and consult events need event-specific
// framing, so extractPrompt handles them separately below.
const PROMPT_EVENT_TYPES = new Set([
  'chat.mention',
  'message.posted',
  'dm.message',
  'first_contact',
]);

// Consultations have a per-request private response channel, rather than a
// pod-chat delivery. They stay on their existing single-event path; every
// event that represents the shared pod inbox is batched below.
const PRIVATE_RESPONSE_EVENT_TYPES = new Set(['agent.ask', 'agent.ask.response']);

// ── default environment for adapters that benefit from auto-MCP wiring ─────

// Adapters that can consume `mcp[]` from the resolved environment spec.
// `claude` reads it via --mcp-config (see adapters/claude.js); `codex` via
// `-c mcp_servers.*` config overrides (see adapters/codex.js — added after
// the 2026-07-22 as-operator attribution incident, where an MCP-less codex
// agent posted through the operator's CLI profile because it had no
// commonly_* tools of its own). `stub` does not. Returning null means "no
// default" — the wrapper proceeds with environment=null exactly like before.
const ADAPTERS_WITH_DEFAULT_MCP = new Set(['claude', 'codex']);
const CODEX_PERMISSION_PROFILE_MIN_VERSION = [0, 138, 0];

const versionAtLeast = (version, minimum) => {
  const parts = String(version || '')
    .match(/\d+(?:\.\d+){1,2}/)?.[0]
    .split('.')
    .map(Number);
  if (!parts) return false;
  for (let i = 0; i < minimum.length; i += 1) {
    const current = parts[i] || 0;
    if (current > minimum[i]) return true;
    if (current < minimum[i]) return false;
  }
  return true;
};

// The commonly behavior skill ships inside this package (cli/skills/commonly)
// so a fresh attach can mount it into the agent without a network fetch.
// Resolved from the module location — works both from source and when the
// package is installed under node_modules/@commonlyai/cli.
const BUNDLED_COMMONLY_SKILL_DIR = pathResolve(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'commonly',
);

// Minimum-viable environment for fresh attach: wire @commonlyai/mcp so the
// agent gets commonly_* kernel tools out of the box, AND mount the commonly
// behavior skill so the agent knows the house rules (orient before posting,
// reply conversationally, use the roster, don't double-post). Without the
// skill, wrapper-spawned CLIs fly blind and behave inconsistently — some
// narrate after tool-posting (double-post), some default to NO_REPLY on a
// normal question. ${COMMONLY_API_URL} / ${COMMONLY_AGENT_TOKEN} are
// substituted at spawn-time by the adapter so the env file stays secret-free.
export const buildDefaultEnvironment = (adapterName) => {
  if (!ADAPTERS_WITH_DEFAULT_MCP.has(adapterName)) return null;
  const environment = {
    mcp: [
      {
        name: 'commonly',
        transport: 'stdio',
        command: ['npx', '-y', '@commonlyai/mcp@latest'],
        env: {
          COMMONLY_API_URL: '${COMMONLY_API_URL}',
          COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
        },
      },
    ],
  };
  // Only advertise the skill if it actually shipped (defensive: a broken
  // package that dropped the skills/ dir shouldn't hand mountSkills a
  // missing-source path every spawn).
  if (existsSync(BUNDLED_COMMONLY_SKILL_DIR)) {
    environment.skills = { claude: [BUNDLED_COMMONLY_SKILL_DIR] };
  }
  return environment;
};

// ── public-pod sandbox gate ─────────────────────────────────────────────────

/**
 * Refuse to attach an agent to a publicly-readable pod unless it declares an
 * enforced sandbox.
 *
 * The public-agent sandbox is real and attack-tested, but it only engages once
 * `sandbox.trust` and `sandbox.mode` are declared: `sandbox.mode` defaults to
 * `'none'`, and nothing previously connected "this pod is public" to "this
 * agent must be confined". An agent attached with no sandbox block simply ran
 * unconfined, silently, with the operator none the wiser.
 *
 * That is not hypothetical — `hq-support` ran that way in a 67-member public
 * pod until 2026-07-27. Its permission deny-list was doing the file-blocking
 * work while the OS-level sandbox never engaged at all.
 *
 * Deny-by-default only means something if ABSENT is refused, so this is a hard
 * error rather than a warning. If the pod's visibility cannot be determined
 * (older server, network failure, permissions), attach proceeds — failing the
 * attach on an unrelated fault would be its own footgun — but says so, because
 * a silent skip is how the original hole stayed invisible.
 */
export const assertSandboxDeclaredForPublicPod = async ({
  client,
  podId,
  environment,
  log = () => {},
}) => {
  if (!podId || !client) return;

  const mode = environment?.sandbox?.mode;
  const trust = environment?.sandbox?.trust;
  const declared = Boolean(trust) && Boolean(mode) && mode !== 'none';
  if (declared) return;

  let pod = null;
  try {
    pod = await client.get(`/api/pods/${podId}`);
  } catch {
    log(
      'warning: could not read pod visibility, so the public-pod sandbox check '
      + 'was skipped. If this pod is public, attach with sandbox.trust=public.',
    );
    return;
  }

  const isPublic = Boolean(pod?.publicRead) || Boolean(pod?.communityListed);
  if (!isPublic) return;

  const label = pod?.name ? `"${pod.name}"` : podId;
  throw new Error(
    `${label} is publicly readable, so this agent would take instructions from `
    + 'people you do not control — but its environment declares no sandbox, and '
    + 'an undeclared sandbox means NO sandbox.\n\n'
    + 'Add a sandbox block to the environment file and retry:\n\n'
    + '  "sandbox": { "trust": "public", "mode": "read-only" }\n\n'
    + 'Modes for a public agent: "read-only" or "workspace" (macOS Seatbelt / '
    + 'Linux bwrap). To attach an agent to a private pod instead, pass that '
    + 'pod id.',
  );
};

// ── wake: toggle ADR-018 ambient wake on an attached agent ──────────────────

/**
 * Set `config.wakeOnMessage.enabled` on an installation via the registry
 * PATCH route (user JWT, pod member or creator). Pure core — takes the token
 * record so the command doesn't need to ask for the pod again.
 */
export const setWakeOnMessage = async ({ client, record, enabled }) => {
  if (!record?.podId || !record?.agentName) {
    throw new Error('token record is missing podId/agentName — re-attach the agent');
  }
  const instanceId = record.instanceId || 'default';
  await client.patch(
    `/api/registry/pods/${record.podId}/agents/${record.agentName}`,
    { instanceId, config: { wakeOnMessage: { enabled: Boolean(enabled) } } },
  );
  return { agentName: record.agentName, podId: record.podId, instanceId, enabled: Boolean(enabled) };
};

// ── attach: register a local-CLI-wrapped agent (ADR-005) ────────────────────

/**
 * Publish, install, and mint a runtime token for a local-CLI-wrapped agent.
 * Pure core — the commander action wraps this with config loading + logging.
 */
export const performAttach = async ({
  client,
  adapterName,
  agentName,
  podId,
  displayName,
  envPath = null,
  wakeOnMessage = false,
  log = () => {},
}) => {
  const adapter = getAdapter(adapterName);
  if (!adapter) {
    throw new Error(
      `Unknown adapter "${adapterName}". Known: ${listAdapterNames().join(', ')}`,
    );
  }

  const detected = await adapter.detect();
  if (!detected) {
    throw new Error(`${adapterName} not found on PATH. Install it and retry.`);
  }

  // ADR-008 §invariant #4: sandbox failure is a hard stop. Validate the env
  // here so attach refuses up front rather than handing the user a runtime
  // that silently degrades to unsandboxed.
  let environment = null;
  let workspace = null;
  if (envPath) {
    environment = await parseEnvironmentFile(envPath);
    workspace = await resolveWorkspace(environment, agentName, dirname(envPath));
    log(`workspace: ${workspace.path}${workspace.created ? ' (created)' : ''}`);

    const sandboxMode = environment.sandbox?.mode || 'none';
    const sandboxTrust = environment.sandbox?.trust;
    if (sandboxTrust === 'public' && sandboxMode === 'none') {
      throw new Error(
        'sandbox.trust=public requires an enforced sandbox mode; refusing to attach unsandboxed',
      );
    }
    if (sandboxMode === 'bwrap') {
      const bwrap = detectBwrap();
      if (!bwrap.available) {
        throw new Error(`sandbox.mode=bwrap requested but unavailable: ${bwrap.error}`);
      }
      if (environment.sandbox?.network?.policy === 'restricted') {
        log(
          'WARNING: bwrap mode does not enforce host allowlist; declared hosts '
          + 'are advisory in Phase 1. Use sandbox.mode=container for enforced policy.',
        );
      }
    } else if (sandboxMode === 'workspace' || sandboxMode === 'read-only') {
      if (sandboxTrust !== 'public' || !['codex', 'claude'].includes(adapterName)) {
        throw new Error(
          `sandbox.mode=${sandboxMode} is currently implemented only for public `
          + `codex or Claude adapters`,
        );
      }
      if (adapterName === 'codex') {
        if (!versionAtLeast(detected.version, CODEX_PERMISSION_PROFILE_MIN_VERSION)) {
          throw new Error(
            `public codex sandbox requires Codex >=0.138.0 permission profiles; `
            + `detected ${detected.version || 'unknown'}`,
          );
        }
        log(
          `sandbox: public ${sandboxMode} via Codex native permission profile `
          + '(deny-by-default filesystem + network)',
        );
      } else {
        const seatbelt = detectSeatbelt();
        if (!seatbelt.available) {
          throw new Error(
            `public Claude sandbox.mode=${sandboxMode} requires macOS Seatbelt: `
            + `${seatbelt.error}. On Linux use sandbox.mode=bwrap.`,
          );
        }
        log(
          `sandbox: public ${sandboxMode} via macOS Seatbelt `
          + '(deny-by-default host filesystem; Claude/MCP network retained)',
        );
      }
    } else if (sandboxMode !== 'none' && sandboxMode !== undefined) {
      throw new Error(
        `sandbox.mode=${sandboxMode} is not yet implemented in the local-CLI driver. `
        + `Supported locally: none, bwrap, and public codex/Claude workspace/read-only.`,
      );
    }
  } else {
    // No --env provided. Apply a sensible default if the adapter supports MCP
    // so a fresh `commonly agent attach claude` gives the agent commonly_*
    // kernel tools out of the box (parity with cloud-codex, which boots with
    // @commonlyai/mcp pre-wired in ~/.codex/config.toml). Operators can still
    // opt out by passing an explicit --env that omits the MCP block.
    // See #440 for the gap that motivated this default.
    environment = buildDefaultEnvironment(adapterName);
    if (environment) {
      log(`environment: applied default with @commonlyai/mcp wired (pass --env to override)`);
    }
  }

  // Deny-by-default has to mean "absent = refuse". Runs outside the branch
  // above because the dangerous case is an agent attached with NO sandbox
  // declaration at all — the branch that validates sandbox settings never
  // executes for those, so the agent silently ran unsandboxed.
  await assertSandboxDeclaredForPublicPod({
    client, podId, environment, log,
  });

  // Identity-bearing runtime tag from the adapter (e.g. 'codex', 'claude-
  // code'). Falls back to adapter.name for adapters that haven't been
  // updated to the two-field scheme. Paired with `host: 'byo'` below so a
  // CLI-attached agent and a cloud-hosted agent of the same identity share
  // the runtimeType and differ only on host. Replaces the old
  // `runtimeType: 'local-cli'` + `wrappedCli` pair (kept readable on the
  // server via legacy normalization).
  const runtimeType = adapter.runtimeType || adapter.name;

  // Idempotent publish — already-published is expected and fine. Install will
  // surface the real error if the manifest is truly unusable.
  try {
    await client.post('/api/registry/publish', {
      manifest: {
        name: agentName,
        version: '1.0.0',
        description: `A local ${adapter.name} agent.`,
        runtimeType,
      },
      displayName: displayName || agentName,
    });
  } catch (err) {
    log(`publish skipped: ${err.message}`);
  }

  // config.runtime is an opaque blob the backend stores verbatim — kernel
  // does not interpret runtimeType here. ADR-004 §Identity's `sourceRuntime`
  // is a different field (memory-sync tag); don't conflate the two.
  // ADR-008 §Attach + run with an environment: include the resolved env spec
  // on config.environment so cross-driver implementations can realize it
  // server-side without re-reading the user's file.
  const installResult = await client.post('/api/registry/install', {
    agentName,
    podId,
    displayName: displayName || agentName,
    version: '1.0.0',
    config: {
      runtime: {
        runtimeType,
        host: 'byo',
      },
      ...(environment ? { environment } : {}),
      // ADR-018: ambient wake is a per-install opt-in read by
      // agentMentionService (`config.wakeOnMessage.enabled === true`, default
      // OFF). Until now the only way to set it for a BYO seat was a DB write.
      ...(wakeOnMessage ? { wakeOnMessage: { enabled: true } } : {}),
    },
    scopes: ['context:read', 'messages:write', 'memory:read', 'memory:write'],
  });

  const installation = installResult.installation || installResult;
  const instanceId = installation.instanceId || 'default';

  let runtimeToken = installResult.runtimeToken;
  if (!runtimeToken) {
    // ADR-005 §detach + reattach: the agent User row's hashed token persists
    // across detach (per ADR-001 identity-continuity), so re-issuance from a
    // fresh attach hits the "already has a runtime token" branch and gets a
    // {existing: true} response with no usable raw token. Pass force:true so
    // the server clears + re-mints — we just deleted the local copy on
    // detach, the prior hash is unrecoverable from the CLI side anyway.
    const tokenData = await client.post(
      `/api/registry/pods/${podId}/agents/${agentName}/runtime-tokens`,
      { force: true },
    );
    runtimeToken = tokenData.token;
  }
  if (!runtimeToken) {
    throw new Error('Runtime token was not returned by install or tokens endpoint');
  }

  return {
    installation,
    instanceId,
    runtimeToken,
    detected,
    wrappedCli: adapter.name,
    environment,
    workspace,
  };
};

// ── memory import (retention plan Phase C) ──────────────────────────────────

/**
 * Detect → preview → confirm → promote local memory into the agent's
 * envelope. Interactive by design: local memory can hold private material,
 * so nothing is sent without an explicit yes (or --yes for scripts; a
 * non-TTY without --yes aborts rather than guessing).
 *
 * Exported for tests; the attach flag and the import-memory subcommand are
 * both thin wrappers over this.
 */
export const runMemoryImport = async ({
  client,
  explicitPath = null,
  yes = false,
  cwd = process.cwd(),
  log = console.log,
  promptFn = null,
}) => {
  const sources = detectMemorySources({ cwd, explicitPath });
  if (!sources.length) {
    log('No local memory found (looked for CLAUDE.md / MEMORY.md / ~/.claude project memory). Pass a path to import a specific file.');
    return { imported: false, reason: 'nothing-found' };
  }

  const totalKb = Math.max(1, Math.round(sources.reduce((n, s) => n + s.bytes, 0) / 1024));
  log(`Found ${sources.length} memory source${sources.length === 1 ? '' : 's'} (${totalKb}KB):`);
  for (const s of sources) {
    log(`  ${s.path}  [${s.label}, ${Math.max(1, Math.round(s.bytes / 1024))}KB]`);
  }
  // Compose up-front so size-ceiling errors surface before the prompt, and
  // the preview shows exactly what would land in the envelope.
  const composed = composeImport(sources);
  const previewLines = composed.split('\n').slice(0, 8);
  log('\nPreview:');
  for (const line of previewLines) log(`  | ${line}`);
  log(`  | … (${composed.length} chars total)\n`);

  if (!yes) {
    if (!process.stdin.isTTY && !promptFn) {
      log('Not a terminal — re-run with --yes to confirm the import.');
      return { imported: false, reason: 'needs-confirmation' };
    }
    const ask = promptFn || (async (q) => {
      const { createInterface } = await import('readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(q);
      rl.close();
      return answer;
    });
    const answer = await ask('Import into this agent\'s memory? Appends to long_term; never overwrites. [y/N] ');
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      log('Import cancelled.');
      return { imported: false, reason: 'declined' };
    }
  }

  const result = await importMemory(client, { sources });
  log(`✓ Imported ${result.files} file${result.files === 1 ? '' : 's'} into long_term memory${result.appended ? ' (appended to existing)' : ''}.`);
  return { imported: true, ...result };
};

// ── run: local-CLI wrapper loop (ADR-005) ────────────────────────────────────

const extractPrompt = (event) => {
  const p = event.payload || {};
  if (PROMPT_EVENT_TYPES.has(event.type)) {
    const content = p.content || p.prompt || p.text || null;
    if (content) return content;
    // #896: a message-shaped event with a messageId but NO content used to be
    // acked silently as "no prompt — no-op", which reads exactly like a
    // swallowed wake (the pilot's boot-backlog mystery — repro'd 2026-08-12:
    // cold starts were healthy; content-less payloads were the whole story).
    // The wrapper has enough to recover: name the message and let the agent
    // read the room. Between silence and one model turn, the #887 rule says
    // spend the turn — the claim gate and cascade cap bound the cost.
    if (p.messageId) {
      return [
        `[Recovered wake: this ${event.type} event named message ${p.messageId} but carried no content — `
        + 'a producer bug, not your fault. Read the recent messages before deciding anything.]',
        'Check the pod\'s recent messages (commonly_get_context / commonly_get_messages), find that message,',
        'and decide whether it needs YOU specifically. Most likely it does not: return NO_REPLY.',
      ].join('\n');
    }
    return null;
  }
  if (event.type === 'heartbeat') {
    return p.content || [
      'Heartbeat tick.',
      'Read your HEARTBEAT.md workspace file and follow it exactly.',
      'HEARTBEAT_OK is a return value — never post it or any narration to pod chat.',
    ].join('\n');
  }
  if (event.type === 'agent.ask') {
    if (!p.requestId || !p.question) return null;
    const sender = p.fromAgent
      ? `@${p.fromAgent}${p.fromInstanceId && p.fromInstanceId !== 'default' ? `:${p.fromInstanceId}` : ''}`
      : 'Another agent';
    return [
      '[Private agent consultation]',
      `${sender} asks:`,
      String(p.question),
      '',
      'Answer the agent directly, including a concise refusal if appropriate.',
      'Your local wrapper will route your final response privately to the requester.',
      'Do not call commonly_respond_to_ask and do not post the answer into pod chat.',
    ].join('\n');
  }
  if (event.type === 'agent.ask.response') {
    if (!p.response) return null;
    const responder = p.fromAgent
      ? `@${p.fromAgent}${p.fromInstanceId && p.fromInstanceId !== 'default' ? `:${p.fromInstanceId}` : ''}`
      : 'The consulted agent';
    return [
      '[Private agent consultation response]',
      ...(p.question ? [`Your question: ${String(p.question)}`] : []),
      `${responder} answered:`,
      String(p.response),
      '',
      'Use this answer to continue the work you were doing.',
      'Only post a concise pod update if a human needs it; otherwise return NO_REPLY.',
    ].join('\n');
  }
  return null;
};

/**
 * Start the run loop. Polls /events, spawns the adapter per event, posts the
 * result into the pod, acks.
 *
 * ADR-005 invariant #4: serialized per agent. The outer poll loop awaits each
 * event before moving to the next; this function is only ever invoked once
 * per `commonly agent run` process, so two spawns never overlap for the same
 * agent.
 *
 * ADR-005 §Spawning semantics: on adapter failure the event is NOT acked, so
 * the kernel re-delivers. This diverges from `startPoller` (which acks all
 * outcomes) — the local-CLI wrapper needs re-delivery on spawn failure because
 * spawn failure is a runtime problem, not a "processed and declined" outcome.
 *
 * ADR-018 D3 (our-drivers row) — deterministic enforcement, added after the
 * 2026-08-11 pilot showed advisory guidance does not bind:
 *   - claim-before-act: message-bearing events are claimed before the spawn;
 *     a lost claim stands the turn down (acked no_action — the holder owns
 *     the conversation, and ITS unacked event covers holder death).
 *   - stand down on lost claim: the lease renews while the CLI runs; if it
 *     lapses and a peer re-wins, the wrapper suppresses its post.
 *   - cascade cap: consecutive agent-triggered turns per pod are capped so a
 *     mention ping-pong damps itself instead of needing a manual kill.
 *   - length gate at post time: wrapper-posted replies are split (never cut)
 *     per the tone contract; document-sized replies attach as a file.
 * Every enforcement failure fails OPEN — a kernel without the claim route or
 * an unreachable upload endpoint must never produce a silent agent (#887).
 */
export const performRun = ({
  instanceUrl,
  token,
  adapter,
  agentName,
  instanceId = 'default',
  podId = null,
  environment = null,
  workspacePath = null,
  intervalMs = 5000,
  log = () => {},
  onError,
  setTimeoutImpl = setTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  retryJitterRatio,
  claimLeaseSeconds = 90,
  // Undefined means "not overridden" — resolveCascadeSettings falls back to
  // the env var, then to the shipped default. Passing a value here still
  // wins, which is how the tests pin a cap of 1.
  cascadeCap,
  cascadeAddressedGrace,
  cascadeResetMs,
  chatCharLimit = 400,
  maxChatChunks = 3,
  claimYieldDelayMs = 3000,
  // ADR-024 D3: a poll is an inbox batch, not ten independent interrupts.
  // Kept injectable for small-page regression cases; the runtime ships with
  // the server's ordinary ten-event page.
  inboxBatchLimit = 10,
  sleepImpl = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) => {
  const client = createClient({ instance: instanceUrl, token });
  let running = true;
  // Stop-after-N-auth-failures: without this, a revoked token leaves the
  // poller hammering 401s forever at 60s backoff — invisible to the user.
  // Exiting tells them to run `commonly agent detach <name>`.
  // 3 is deliberate — 1 would churn on a token-rotation race during
  // reprovision-all; 5+ wastes rate-limit budget after the real-revoke case.
  let consecutiveAuthErrors = 0;
  const MAX_AUTH_ERRORS = 3;
  let consecutivePollFailures = 0;
  let consecutiveSpawnFailures = 0;
  const spawnJitterRatio = retryJitterRatio ?? spawnRetryJitter(agentName);
  // Per-seat cascade state — lives with the process, like the session store.
  // A wrapper restart forgets the streak; the decay window covers that gap.
  const cascadeSettings = resolveCascadeSettings({
    overrides: {
      cap: cascadeCap,
      addressedGrace: cascadeAddressedGrace,
      resetMs: cascadeResetMs,
    },
    warn: (message) => log(`cascade config: ${message}`),
  });
  const cascadeGovernor = createCascadeGovernor(cascadeSettings);
  // Unconditional, because the only other cascade line on this path is the
  // warn callback above — which fires only when a value is BAD. Without this,
  // a seat running COMMONLY_CASCADE_CAP=8 logs exactly what a seat on the
  // shipped default logs, and an env var (unlike the source edit it replaces)
  // leaves no git evidence of which seat diverged. The `(defaults)` marker
  // makes "show me every retuned seat" a grep for its absence.
  const cascadeIsDefault = Object.keys(CASCADE_DEFAULTS)
    .every((key) => cascadeSettings[key] === CASCADE_DEFAULTS[key]);
  log(
    `cascade: cap=${cascadeSettings.cap} grace=${cascadeSettings.addressedGrace} `
    + `reset=${cascadeSettings.resetMs}ms${cascadeIsDefault ? ' (defaults)' : ''}`,
  );
  // Fairness: recent broadcast-race winners start the next race from the back.
  const claimHandicap = createClaimHandicap({ delayMs: claimYieldDelayMs });

  // Adapters default `ctx.cwd` to this path. Node's child_process.spawn
  // rejects with "spawn <bin> ENOENT" when cwd does not exist — same shape
  // as binary-not-found — so we ensure it up front to avoid the confusing
  // diagnostic. ADR-008: when an environment spec was attached, the resolved
  // workspace path replaces the /tmp default.
  const agentCwd = workspacePath || join(tmpdir(), 'commonly-agents', agentName);
  if (!existsSync(agentCwd)) mkdirSync(agentCwd, { recursive: true });
  const batchLimit = Math.min(50, Math.max(1, Number(inboxBatchLimit) || 10));

  const processEvent = async (event) => {
    const eventPodId = event.podId || podId;
    const prompt = extractPrompt(event);
    if (!prompt || !eventPodId) {
      // No prompt, or nowhere to post the response — skip spawn entirely so
      // we never consume a CLI turn for a message with no destination.
      // Surfaced through onError, not just the log: a silently-acked event is
      // indistinguishable from a swallowed wake (#896 — the pilot burned an
      // evening on exactly this ambiguity). It is still acked (deliberate
      // decline, not a retry), but the operator can now see the skip.
      log(`[${event.type}] no prompt — no-op`);
      onError?.(Object.assign(
        new Error(
          `${event.type} event ${event._id} was acked WITHOUT a spawn: `
          + `${!eventPodId ? 'no podId to post into' : 'payload carried no content and no messageId'}. `
          + 'If this wake mattered, its producer is sending an unusable payload.',
        ),
        { code: 'agent_event_skipped_no_prompt', eventId: event._id },
      ));
      return { outcome: 'no_action', reason: 'no-prompt' };
    }

    // Snapshot the pod's recent messages so that, after the spawn, we can
    // tell whether the agent posted itself via commonly_post_message. If it
    // did, its final CLI text is a narration/log — echoing it would duplicate
    // the message and re-fire any @mention. This is the wrapper-side guarantee
    // that a deliberate multi-post ("on it…" then "…done") is never doubled,
    // without relying on the agent to emit NO_REPLY. Against a server that
    // stamps `self` this is exact; against an older one it degrades to the
    // legacy any-bot test, where a concurrent post by another agent can
    // suppress a genuine reply (#757).
    const snapshotMessages = async () => {
      try {
        const { messages = [] } = await client.get(
          `/api/agents/runtime/pods/${eventPodId}/messages`, { limit: 10 },
        );
        return messages;
      } catch {
        return null; // detection unavailable — fall back to posting the reply
      }
    };
    // A consult request's final output is routed to the ask-response endpoint,
    // never echoed into the pod. It therefore does not need pod-message
    // snapshotting (and cannot be detected through that channel anyway).
    // The snapshot doubles as the cascade governor's authorship source, so it
    // runs BEFORE enforcement.
    const shouldSnapshotMessages = event.type !== 'agent.ask';
    const preSpawn = shouldSnapshotMessages ? await snapshotMessages() : null;
    const preSpawnIds = preSpawn
      ? new Set(preSpawn.map((m) => String(m._id || m.id)))
      : null;

    // ── ADR-018 enforcement: cascade cap ────────────────────────────────────
    // Refusing here is a deliberate, permanent decline (acked no_action): a
    // capped agent-triggered event is exactly the traffic we want dropped.
    // Human-triggered turns are never capped.
    const trigger = classifyTrigger(event, preSpawn);
    // A human turn is a property of the POD, not of this seat's reaction to
    // it. Record it as soon as it is classified — before the cascade check and
    // before the claim race — so a seat that stands down still observes the
    // reset.
    //
    // Without this, losing a claim on a human message is SELF-REINFORCING.
    // The claim stand-down returns before `runTurn`, and `record()` lives at
    // the end of `runTurn`, so the loser never records the human turn that
    // would have cleared its streak. It meets the next broadcast still capped,
    // declines, and again skips `record()`. The only other escape is the
    // seat's own resetMs clock: stateFor reads only this process's
    // lastAgentTurnAt, so a capped seat self-clears 10 minutes after its last
    // completed agent turn regardless of room traffic — cyclical throttling,
    // not permanent starvation.
    //
    // Measured in one pod, 2026-08-18, same window: ux-lead 14 lost claims /
    // 73 cap refusals / 2 posts, against sprint-review 0 / 2 / 95. Losing one
    // race is what kept it losing — the mechanism meant to SHARE work
    // concentrated it instead.
    //
    // `=== 'human'` rather than `!== 'agent'`. These are behaviourally the
    // same today: `record()` dispatches on exact equality and leaves every
    // other value untouched, including the 'unknown' that `classifyTrigger`
    // returns for an unresolvable trigger — `enforcement.js:123-131`, and the
    // "'unknown' is neutral: no count, no reset" note at :130. The narrow form
    // is defensive, not load-bearing: it keeps an unidentifiable event from
    // becoming a cap-reset primitive if `record()` ever grows a fallthrough
    // branch. It closes no hole that was open.
    //
    // Agent-triggered turns still record only on completion (see `runTurn`),
    // so the no-double-count property for redelivered events is unchanged.
    // Recording a human trigger sets the streak to 0, so this call and the
    // completion-time one are idempotent with each other.
    if (trigger === 'human') cascadeGovernor.record(eventPodId, trigger);
    const admission = cascadeGovernor.admit(eventPodId, trigger, event.type, event.payload);
    if (!admission.allowed) {
      // Name the MESSAGE, not just the pod. Without this the refusal is silent at
      // three ends, not two: the mentioning agent gets no signal its mention died,
      // an operator reading the log cannot tell which mentions were dropped, and
      // the suppressed seat cannot say what it ignored — it never saw the id. Two
      // real mentions were lost this way on 2026-08-19 and the seat they were
      // addressed to could not enumerate them afterwards.
      log(
        `[${event.type}] cascade cap: ${admission.streak} consecutive agent-triggered `
        + `turns in pod ${eventPodId}`
        + (event?.payload?.messageId ? ` (dropped message ${event.payload.messageId})` : '')
        + (admission.graceApplied ? ' (addressed grace also spent)' : '')
        // NOT "until the pod goes quiet": other seats' traffic never touches
        // this seat's clock, and a refusal returns here without reaching
        // `record()` below — so the window is measured from this seat's last
        // ADMITTED turn in this pod and runs regardless of how loud the room
        // is. Saying "the pod goes quiet" told an operator to wait for a lull
        // that is neither necessary nor sufficient (#989).
        + ` — standing down until a human speaks or ${cascadeSettings.resetMs}ms `
        + 'passes with no admitted turn from this seat in this pod',
      );
      // `details` rides through to the AgentEvent row untouched:
      // normalizeDeliveryMeta whitelists outcome/reason/messageId and passes
      // `details` straight into `delivery.details`, typed Schema.Types.Mixed.
      // So the settings that produced this refusal become queryable with NO
      // backend change and no deploy.
      //
      // This is the half the boot log cannot cover. The log says what a seat
      // resolved; it does not survive a restart, and nothing joins it to the
      // refusals it caused. Once cap is per-seat and arbitrary, a refusal
      // whose cap is unknown cannot be compared against one from another seat.
      // `reason` deliberately stays the fixed literal 'cascade-cap' — :1111
      // matches it with === and the run-loop tests assert it — so the value
      // goes in a sibling field instead of being spelled into the reason.
      return {
        outcome: 'no_action',
        reason: 'cascade-cap',
        details: {
          // The id of what was dropped. `reason` and `streak` say a refusal
          // happened; only this says WHICH message never got answered, which is
          // what anyone auditing a missed mention actually needs to join on.
          messageId: event?.payload?.messageId || null,
          streak: admission.streak,
          cap: cascadeSettings.cap,
          addressedGrace: cascadeSettings.addressedGrace,
          resetMs: cascadeSettings.resetMs,
          addressed: admission.addressed,
          graceApplied: admission.graceApplied,
        },
      };
    }

    // ── ADR-018 enforcement: claim-before-act ───────────────────────────────
    // Losing a BROADCAST race is a complete turn (stand down, ack): the
    // holder owns the conversation, and liveness on holder death comes from
    // the HOLDER's own event staying unacked, not from ours. Losing while
    // DIRECTLY ADDRESSED is different — a human chose this seat, and that
    // outranks being beaten to a CAS: the seat still gets its turn, peer-aware
    // (add your view only if materially different). Claim-route failures
    // proceed unguarded — enforcement must never make an agent silent (#887).
    let claimKeeper = null;
    let peerFrame = null;
    const claimMessageId = event.payload?.messageId;
    if (claimMessageId && CLAIMABLE_EVENT_TYPES.has(event.type)) {
      // Fairness: the winner of this pod's previous broadcast race enters the
      // next one after a jittered delay. Everyone still claims — a hard
      // cooldown could leave a message with NO claimant, which is #887
      // self-inflicted — recent winners just start from the back.
      if (event.type === 'message.posted') {
        const yieldMs = claimHandicap.yieldDelayMs(eventPodId);
        if (yieldMs > 0) {
          log(`[${event.type}] yielding ${yieldMs}ms before claiming — won this pod's previous broadcast race`);
          await sleepImpl(yieldMs);
        }
      }
      claimKeeper = createClaimKeeper(client, {
        messageId: claimMessageId,
        podId: eventPodId,
        leaseSeconds: claimLeaseSeconds,
        log: (line) => log(`[${event.type}] ${line}`),
        setIntervalImpl,
        clearIntervalImpl,
      });
      const claim = await claimKeeper.acquire();
      if (!claim.claimed && !claim.failOpen) {
        // Per-event EVIDENCE, deliberately not a widening of
        // ADDRESSED_EVENT_TYPES (that set is a pricing table): the backend
        // stamps repliesToYourMessage when the woken message replies to or
        // threads on a message THIS seat authored. Without it, a peer's
        // claim on its own reply ordered the replied-to author out of its
        // own conversation (Sage stood down twice on Anvil's thread
        // replies, 2026-08-24). Interim for TASK-058.
        const repliesToThisSeat = event.payload?.repliesToYourMessage === true;
        if (ADDRESSED_EVENT_TYPES.has(event.type) || repliesToThisSeat) {
          log(
            `[${event.type}] message ${claimMessageId} held by ${claim.holder} — `
            + (repliesToThisSeat
              ? 'proceeding peer-aware (the message replies to this seat\'s own message)'
              : 'proceeding peer-aware (this seat was directly addressed)'),
          );
          peerFrame = peerHoldsFrame(claim.holder, claimMessageId);
          claimKeeper = null; // nothing held: no renewal, no release, no isLost gate
        } else {
          claimHandicap.recordLoss(eventPodId);
          log(`[${event.type}] message ${claimMessageId} already claimed by ${claim.holder} — standing down`);
          return { outcome: 'no_action', reason: 'claim-held' };
        }
      } else if (claim.claimed) {
        if (event.type === 'message.posted') claimHandicap.recordWin(eventPodId);
        claimKeeper.startRenewal();
      } else {
        log(`[${event.type}] claim unavailable (${claim.error?.message || 'unknown error'}) — proceeding unguarded`);
      }
    }

    let turnResult;
    try {
      turnResult = await runTurn({
        event,
        eventPodId,
        prompt: peerFrame ? `${peerFrame}\n\n${prompt}` : prompt,
        preSpawnIds,
        snapshotMessages,
        claimKeeper,
        trigger,
      });
      return turnResult;
    } finally {
      // A silent, normally completed human wake is an explicit decline, not
      // a successful answer. Tell the kernel so it can hand the message to
      // exactly one remaining original listener. Any posted reply, refusal
      // with a reason, or thrown spawn retains completion/legacy semantics:
      // re-offering those would duplicate a visible response or defeat normal
      // at-least-once redelivery after an infrastructure failure.
      const claimOutcome = event.type === 'message.posted'
        && event.payload?.senderIsHuman === true
        && turnResult?.outcome === 'no_action' && !turnResult?.reason
        ? 'declined'
        : (turnResult ? 'completed' : undefined);
      await claimKeeper?.release(claimOutcome);
    }
  };

  // The spawn → post-decision half of a turn, split out so the claim release
  // above is a plain finally instead of threading through every return path.
  const runTurn = async ({
    event, eventPodId, prompt, preSpawnIds, snapshotMessages, claimKeeper, trigger,
  }) => {
    const sessionId = getSession(agentName, eventPodId);
    // ADR-005 §Memory bridge: read long_term before spawn, inject via ctx,
    // and (if the adapter returns a summary) patch-sync back after.
    const memoryLongTerm = await readLongTerm(client, { onError });

    log(`[${event.type}] spawning ${adapter.name}`);
    const result = await adapter.spawn(prompt, {
      sessionId,
      cwd: agentCwd,
      env: process.env,
      memoryLongTerm,
      environment,
      // Runtime context the Claude/Codex adapters expose only to their
      // per-spawn MCP environment. Claude keeps ${COMMONLY_*} placeholders
      // literal on disk and lets its native MCP parser expand them, so the
      // bearer token never enters the generated config file.
      runtimeToken: token,
      instanceUrl,
      agentName,
      metadata: { event },
    });

    if (result.newSessionId) {
      setSession(agentName, eventPodId, result.newSessionId);
    }
    // Decide whether to post the CLI's final text. The agent owns its posting:
    // if it already spoke this turn through commonly_post_message, echoing its
    // output would double-post. Two independent signals suppress the echo:
    //   1. Detection — a new message appeared in the pod during the spawn (the
    //      agent posted via the tool). Automatic; no agent cooperation needed.
    //   2. NO_REPLY — the agent explicitly asks us to stay silent. Honored only
    //      when it's the ENTIRE reply; mixed content still posts verbatim.
    // Otherwise (a bare CLI with no posting tools, or an agent that chose to
    // reply via its output) the wrapper delivers the text as before.
    const replyText = (result.text || '').trim();
    let agentPostedItself = false;
    let suppressedBy = null;
    if (preSpawnIds) {
      const postSpawn = await snapshotMessages();
      if (postSpawn) {
        // The server stamps each message with `self` when it knows who is
        // asking. Trust that over any local guess: the wrapper cannot derive
        // its own bot username reliably (the server applies LEGACY_AGENT_MAP
        // and an owner-scoped instanceId), and a wrong guess double-posts.
        const serverKnowsSelf = postSpawn.some((m) => typeof m.self === 'boolean');
        for (const m of postSpawn) {
          if (preSpawnIds.has(String(m._id || m.id))) continue;
          // A new human-authored message must NEVER suppress the echo: it is
          // either a human typing mid-turn, or the agent misusing an operator
          // CLI profile / human token (the 2026-07-22 as-operator attribution
          // incident) — in both cases the wrapper still delivers the reply
          // under the agent's own identity.
          if (!m.isBot) continue;
          // With `self`, only THIS agent's own post suppresses. Without it (an
          // older server), fall back to the legacy any-bot test — which drops
          // this agent's reply whenever another agent answers first (#757).
          if (serverKnowsSelf ? m.self === true : true) {
            agentPostedItself = true;
            suppressedBy = {
              id: String(m._id || m.id),
              author: m.username || 'unknown',
              basis: serverKnowsSelf ? 'self' : 'legacy-any-bot',
            };
            break;
          }
        }
      }
    }
    const heartbeatControlReply = (event.type === 'heartbeat' || event.payload?.hasHeartbeat === true)
      && /^(HEARTBEAT_OK|HEARTBEAT_NOOP)$/i.test(replyText);
    const silentReply = !replyText || replyText === 'NO_REPLY' || heartbeatControlReply;
    let delivered = agentPostedItself;
    let deliveryRefusal = null;

    if (event.type === 'agent.ask') {
      if (silentReply) {
        const reason = heartbeatControlReply ? replyText : (replyText || 'empty output');
        log(`[${event.type}] no private response (${reason})`);
      } else {
        try {
          await client.post(
            `/api/agents/runtime/asks/${encodeURIComponent(event.payload.requestId)}/respond`,
            { content: replyText },
          );
          delivered = true;
          log(`[${event.type}] routed private response (${Buffer.byteLength(replyText)} bytes)`);
        } catch (err) {
          // A tool-capable agent may have called commonly_respond_to_ask
          // despite the wrapper instruction. Treat the kernel's idempotent
          // "already responded" result as delivered rather than re-running
          // the model forever.
          if (err?.status === 409 && err?.body?.code === 'already_responded') {
            delivered = true;
            log(`[${event.type}] response already routed by agent tool`);
          } else {
            throw err;
          }
        }
      }
    } else if (silentReply) {
      const reason = heartbeatControlReply ? replyText : (replyText || 'empty output');
      // A turn that posted via tool and THEN ended with the sentinel is not the
      // same event as a turn that produced nothing — but this branch reported
      // both as `no wrapper-post (NO_REPLY)`, because it is evaluated before
      // the `agentPostedItself` branch below and swallowed that fact.
      //
      // The skill told agents to do exactly this (post via commonly_post_message,
      // then end with NO_REPLY so the wrapper does not double-post), so CORRECT
      // behaviour and total silence were indistinguishable on stdout.
      //
      // Cost, 2026-08-18: a seat was diagnosed as mute for "19 hours" on the
      // strength of `grep -c "posted via tool" == 0` against its log. It had in
      // fact posted seven times in that window. Five remedies were applied to a
      // seat that was never broken — cleared session, fresh process, MCP
      // repointed, model repinned — before the seat itself pointed at the
      // ledger. The instrument was broken, not the agent.
      //
      // Report the two cases distinctly. `posted` is the load-bearing word: a
      // reader scanning for whether a seat is contributing must not have to
      // infer it from the absence of a different line.
      if (agentPostedItself) {
        log(
          `[${event.type}] posted via tool, then ${reason} — no echo needed `
          + `(matched message ${suppressedBy.id} by ${suppressedBy.author} `
          + `via ${suppressedBy.basis})`,
        );
      } else {
        log(`[${event.type}] no wrapper-post (${reason}) — nothing posted this turn`);
      }
    } else if (agentPostedItself) {
      // Name the message that caused the suppression. A silently dropped reply
      // is invisible to everyone; #757 went unnoticed precisely because this
      // line said only "posted via tool" with no way to tell whose post it saw.
      log(
        `[${event.type}] agent posted via tool this turn — not echoing CLI output `
        + `(avoids double-post; matched message ${suppressedBy.id} by ${suppressedBy.author} `
        + `via ${suppressedBy.basis})`,
      );
    } else if (claimKeeper?.isLost()) {
      // ADR-018 D3: the lease lapsed mid-turn and a peer re-won the message —
      // that peer owns the conversation now, so posting would recreate the
      // two-agents-one-message crossing the claim exists to prevent.
      log(
        `[${event.type}] stood down — claim lost mid-turn to ${claimKeeper.getHolder()}; `
        + `reply suppressed (${Buffer.byteLength(replyText)} bytes not posted)`,
      );
    } else {
      // ADR-018 length gate: the tone contract is enforced here, where the
      // wrapper is the one posting. Split, attach — never truncate.
      const delivery = await deliverChatReply({
        client,
        podId: eventPodId,
        text: replyText,
        limit: chatCharLimit,
        maxChunks: maxChatChunks,
        uploadName: `${agentName}-reply-${event._id}.md`,
        log: (line) => log(`[${event.type}] ${line}`),
      });
      if (delivery.refused) {
        // A run-cap refusal is a successful HTTP request but not a delivery.
        // Ack it so the kernel does not replay the same text (the server
        // guidance expressly says not to retry unchanged), while preserving
        // the refusal and its partial-post count for the seat and event ledger.
        deliveryRefusal = delivery;
        const guidance = delivery.guidance || 'The server refused this message; do not retry it unchanged.';
        const detail = `after ${delivery.messages}/${delivery.attemptedMessages} message${delivery.attemptedMessages === 1 ? '' : 's'}`;
        log(`[${event.type}] wrapper delivery refused ${detail} (${delivery.reason}): ${guidance}`);
        onError?.(Object.assign(
          new Error(`${event.type} wrapper delivery refused ${detail}: ${guidance}`),
          {
            code: 'agent_delivery_refused',
            reason: delivery.reason,
            eventId: event._id,
            postedMessages: delivery.messages,
            attemptedMessages: delivery.attemptedMessages,
          },
        ));
      } else {
        delivered = true;
        log(
          `[${event.type}] posted ${Buffer.byteLength(replyText)} bytes as `
          + `${delivery.messages} message${delivery.messages === 1 ? '' : 's'} (${delivery.mode})`,
        );
      }
    }
    if (result.memorySummary) {
      try {
        await syncBack(client, { summary: result.memorySummary });
        log(`[${event.type}] memory synced (${Buffer.byteLength(result.memorySummary)} bytes)`);
      } catch (err) {
        // Memory-sync failure is non-fatal: the turn already posted, and the
        // next spawn will re-read from the kernel anyway. Surface, don't
        // throw. Preserve the original error via `cause` so the stack trace
        // survives for CLI debugging.
        onError?.(new Error(`memory sync failed: ${err.message}`, { cause: err }));
      }
    }
    // The turn completed — count it toward (or reset) the pod's cascade
    // streak. Recording only on completion means a spawn failure that gets
    // redelivered never double-counts toward the cap.
    cascadeGovernor.record(eventPodId, trigger);
    if (deliveryRefusal) {
      return {
        outcome: 'no_action',
        reason: deliveryRefusal.reason,
        details: {
          mode: deliveryRefusal.mode,
          postedMessages: deliveryRefusal.messages,
          attemptedMessages: deliveryRefusal.attemptedMessages,
          ...(typeof deliveryRefusal.consecutive === 'number'
            ? { consecutive: deliveryRefusal.consecutive }
            : {}),
          ...(deliveryRefusal.guidance ? { guidance: deliveryRefusal.guidance } : {}),
        },
      };
    }
    return { outcome: delivered ? 'posted' : 'no_action' };
  };

  // ADR-024 D3: the batch header states the real inbox count even when we cap
  // copied bodies. The cap is the fetched page itself: never acknowledge a
  // claimed event whose body the one turn did not receive. Additional pending
  // events stay in the kernel queue and are cued in the header for a later
  // pull, rather than being silently consumed here.
  const buildInboxPrompt = (entries, inboxCount = entries.length) => {
    const BODY_LIMIT = batchLimit;
    const bodies = entries.slice(0, BODY_LIMIT).map((entry, index) => {
      const messageId = entry.event.payload?.messageId;
      const prefix = [
        `Event ${index + 1}/${entries.length}: ${entry.event.type}`,
        messageId ? `message ${messageId}` : null,
      ].filter(Boolean).join(' — ');
      const claimContext = entry.readOnly
        ? `${peerHoldsFrame(entry.holder, messageId)}\n`
          + '[This item is read-only context: a peer won its binding claim. Do not act on it.]\n'
        : (entry.peerFrame ? `${entry.peerFrame}\n` : '');
      const body = entry.prompt || '[No usable prompt was delivered for this item.]';
      return `${prefix}\n${claimContext}${body}`;
    });
    const omitted = Math.max(0, inboxCount - bodies.length);
    return [
      `[Inbox batch: ${inboxCount} new event${inboxCount === 1 ? '' : 's'} in this pod. `
        + 'This is one turn: read the included items together, then decide what needs YOU.]',
      ...bodies,
      ...(omitted > 0
        ? [`[${omitted} more event${omitted === 1 ? '' : 's'} arrived. Their count is real; pull pod context if needed.]`]
        : []),
      'Do not narrate the inbox. Post only an action or a materially useful response; otherwise return NO_REPLY.',
    ].join('\n\n');
  };

  const batchAdmissionResult = (event, admission) => ({
    outcome: 'no_action',
    reason: 'cascade-cap',
    details: {
      messageId: event?.payload?.messageId || null,
      streak: admission.streak,
      cap: cascadeSettings.cap,
      addressedGrace: cascadeSettings.addressedGrace,
      resetMs: cascadeSettings.resetMs,
      addressed: admission.addressed,
      graceApplied: admission.graceApplied,
    },
  });

  // Claim the binding portion before the ONE composite spawn. A lost binding
  // claim is not discarded: it remains in the model's context with the same
  // peer frame the single-event path already uses, but is explicitly read-only.
  // Advisory losses retain their existing peer-aware behaviour.
  const processEventBatch = async (events, inboxCount = events.length) => {
    const eventPodId = events[0]?.podId || podId;
    if (!eventPodId || events.some((event) => (event.podId || podId) !== eventPodId)) {
      throw new Error('Inbox batch crossed pod boundaries; refusing to mix private pod context');
    }

    const entries = events.map((event) => ({
      event,
      prompt: extractPrompt(event),
      result: null,
      claimKeeper: null,
      peerFrame: null,
      readOnly: false,
      holder: null,
    }));

    // Duplicate deliveries have already completed locally. Re-ack them but do
    // not spend the new batch turn displaying old work as if it were new.
    const seenEventIds = new Set();
    for (const entry of entries) {
      const eventId = String(entry.event._id);
      if (seenEventIds.has(eventId) || wasEventHandled(agentName, entry.event._id)) {
        entry.result = { outcome: 'no_action', reason: 'duplicate-delivery' };
        log(`[${entry.event.type}] duplicate delivery ${entry.event._id} — re-acking without batch spawn`);
      } else {
        seenEventIds.add(eventId);
      }
      if (entry.result?.reason === 'duplicate-delivery') {
        continue;
      }
      if (!entry.prompt) {
        entry.result = { outcome: 'no_action', reason: 'no-prompt' };
        log(`[${entry.event.type}] no prompt — no-op`);
        onError?.(Object.assign(
          new Error(
            `${entry.event.type} event ${entry.event._id} was acked WITHOUT a spawn: `
            + 'payload carried no content and no messageId. If this wake mattered, its producer is sending an unusable payload.',
          ),
          { code: 'agent_event_skipped_no_prompt', eventId: entry.event._id },
        ));
      }
    }

    const snapshotMessages = async () => {
      try {
        const { messages = [] } = await client.get(
          `/api/agents/runtime/pods/${eventPodId}/messages`, { limit: 10 },
        );
        return messages;
      } catch {
        return null;
      }
    };
    const preSpawn = await snapshotMessages();
    const preSpawnIds = preSpawn
      ? new Set(preSpawn.map((message) => String(message._id || message.id)))
      : null;
    const activeEntries = entries.filter((entry) => !entry.result);
    const triggers = activeEntries.map((entry) => classifyTrigger(entry.event, preSpawn));
    const trigger = triggers.includes('human') ? 'human'
      : (triggers.includes('agent') ? 'agent' : 'unknown');
    if (trigger === 'human') cascadeGovernor.record(eventPodId, trigger);
    const admissionEvent = activeEntries.find((entry) => ADDRESSED_EVENT_TYPES.has(entry.event.type))
      || activeEntries[0];
    if (admissionEvent) {
      const admission = cascadeGovernor.admit(
        eventPodId,
        trigger,
        admissionEvent.event.type,
        admissionEvent.event.payload,
      );
      if (!admission.allowed) {
        for (const entry of activeEntries) {
          entry.result = batchAdmissionResult(entry.event, admission);
        }
        return { entries };
      }
    }

    const bindingEntries = activeEntries.filter((entry) => (
      entry.event.type === 'message.posted' && entry.event.payload?.messageId
    ));
    if (bindingEntries.length > 0) {
      const yieldMs = claimHandicap.yieldDelayMs(eventPodId);
      if (yieldMs > 0) {
        log(`[inbox.batch] yielding ${yieldMs}ms before claiming ${bindingEntries.length} binding event${bindingEntries.length === 1 ? '' : 's'}`);
        await sleepImpl(yieldMs);
      }
    }

    for (const entry of activeEntries) {
      const messageId = entry.event.payload?.messageId;
      if (!messageId || !CLAIMABLE_EVENT_TYPES.has(entry.event.type)) continue;
      const claimKeeper = createClaimKeeper(client, {
        messageId,
        podId: eventPodId,
        leaseSeconds: claimLeaseSeconds,
        log: (line) => log(`[${entry.event.type}] ${line}`),
        setIntervalImpl,
        clearIntervalImpl,
      });
      const claim = await claimKeeper.acquire();
      if (claim.claimed) {
        entry.claimKeeper = claimKeeper;
        claimKeeper.startRenewal();
        if (entry.event.type === 'message.posted') claimHandicap.recordWin(eventPodId);
      } else if (!claim.failOpen) {
        entry.holder = claim.holder;
        if (entry.event.type === 'message.posted') {
          // A reply to this seat's own message is direct-address evidence,
          // even though its transport type is the broadcast-shaped
          // `message.posted`. Preserve the existing ADR-018/TASK-058
          // peer-aware exception; D3a otherwise partitions lost bindings as
          // read-only so a generic broadcast cannot widen itself after CAS.
          if (entry.event.payload?.repliesToYourMessage === true) {
            entry.peerFrame = peerHoldsFrame(claim.holder, messageId);
            continue;
          }
          // D3a's partition: no later model judgement can widen this item's
          // authority after a peer won the binding CAS.
          entry.readOnly = true;
          entry.result = { outcome: 'no_action', reason: 'claim-held' };
          claimHandicap.recordLoss(eventPodId);
        } else {
          entry.peerFrame = peerHoldsFrame(claim.holder, messageId);
        }
      } else {
        log(`[${entry.event.type}] claim unavailable (${claim.error?.message || 'unknown error'}) — proceeding unguarded`);
      }
    }

    const actionEntries = activeEntries.filter((entry) => !entry.result);
    if (actionEntries.length === 0) return { entries };

    const claimKeepers = actionEntries
      .map((entry) => entry.claimKeeper)
      .filter(Boolean);
    const compositeClaimKeeper = claimKeepers.length > 0 ? {
      isLost: () => claimKeepers.some((keeper) => keeper.isLost()),
      getHolder: () => claimKeepers.find((keeper) => keeper.isLost())?.getHolder(),
    } : null;
    const batchEvent = {
      ...actionEntries[0].event,
      _id: `batch-${actionEntries[0].event._id}`,
      type: 'inbox.batch',
      payload: {
        ...actionEntries[0].event.payload,
        batchEventIds: entries.map((entry) => String(entry.event._id)),
        hasHeartbeat: entries.some((entry) => entry.event.type === 'heartbeat'),
      },
    };
    let turnResult;
    try {
      turnResult = await runTurn({
        event: batchEvent,
        eventPodId,
        prompt: buildInboxPrompt(entries, inboxCount),
        preSpawnIds,
        snapshotMessages,
        claimKeeper: compositeClaimKeeper,
        trigger,
      });
      for (const entry of actionEntries) entry.result = turnResult;
      return { entries };
    } finally {
      await Promise.all(actionEntries
        .filter((entry) => entry.claimKeeper)
        .map(async (entry) => {
          // Preserve ADR-018 D6.1 per binding message: a silent human
          // broadcast may be handed to one remaining listener, while every
          // other completed batch item closes normally.
          const claimOutcome = entry.event.type === 'message.posted'
            && entry.event.payload?.senderIsHuman === true
            && turnResult?.outcome === 'no_action' && !turnResult?.reason
            ? 'declined'
            : (turnResult ? 'completed' : undefined);
          await entry.claimKeeper.release(claimOutcome);
        }));
    }
  };

  const tick = async () => {
    if (!running) return;
    let nextPollDelayMs = intervalMs;
    try {
      // ADR-024 D3: this is an inbox fetch, not a stream of interrupts. The
      // backend returns one pod's oldest pending batch, so every delivered row
      // below reaches the SAME composite turn before it can age into the
      // requeue sweep. The service selects the pod before claiming any row;
      // do not reintroduce a mixed-pod `limit: 10` here.
      const { events = [], inboxCount } = await client.get('/api/agents/runtime/events', {
        agentName, instanceId, limit: batchLimit,
      });
      consecutiveAuthErrors = 0;
      consecutivePollFailures = 0;
      // A deployed CLI can briefly run against an older server that still
      // returns multiple pods in one page. Preserve pod privacy in that
      // migration window by partitioning locally. Current servers produce one
      // group, so the normal path remains one tick → one turn.
      const eventGroups = new Map();
      for (const event of events) {
        const eventPodId = event.podId || podId;
        const key = PRIVATE_RESPONSE_EVENT_TYPES.has(event.type)
          ? `private:${event._id}`
          : (eventPodId || `private:${event._id}`);
        const group = eventGroups.get(key) || [];
        group.push(event);
        eventGroups.set(key, group);
      }
      for (const group of eventGroups.values()) {
        if (!running) break;
        if ((group[0].podId || podId) && !PRIVATE_RESPONSE_EVENT_TYPES.has(group[0].type)) {
          let batch;
          try {
            batch = await processEventBatch(group, inboxCount);
          } catch (err) {
            consecutiveSpawnFailures += 1;
            const retry = spawnRetryPolicy({
              error: err,
              consecutiveFailures: consecutiveSpawnFailures,
              intervalMs,
              jitterRatio: spawnJitterRatio,
            });
            nextPollDelayMs = retry.delayMs;
            const event = group[0];
            const wrapped = new Error(
              `inbox batch processing failed (${retry.failureClass}; ${consecutiveSpawnFailures} consecutive) `
              + `— ${group.length} events remain unacked; ${retry.circuitOpen ? 'circuit open' : 'retry scheduled'}, `
              + `next probe in ${formatRetryDelay(retry.delayMs)}: ${err.message}`,
              { cause: err },
            );
            Object.assign(wrapped, {
              code: 'agent_spawn_retry_scheduled',
              failureClass: retry.failureClass,
              consecutiveFailures: consecutiveSpawnFailures,
              retryAfterMs: retry.delayMs,
              circuitOpen: retry.circuitOpen,
              eventId: event._id,
            });
            if (onError) onError(wrapped);
            else log(`[inbox.batch] ${wrapped.message}`);
            break;
          }
          const batchSpawned = batch.entries.some((entry) => (
            entry.result?.outcome === 'posted'
            || (entry.result?.outcome === 'no_action' && !entry.result?.reason)
          ));
          if (batchSpawned) consecutiveSpawnFailures = 0;
          for (const entry of batch.entries) {
            const event = entry.event;
            if (entry.result?.reason !== 'duplicate-delivery') {
              recordHandledEvent(agentName, event._id);
            }
            try {
              const deliveryId = event.payload?.deliveryId;
              await client.post(`/api/agents/runtime/events/${event._id}/ack`, {
                result: entry.result,
                ...(typeof deliveryId === 'string' && deliveryId ? { deliveryId } : {}),
              });
            } catch (ackErr) {
              onError?.(new Error(`Ack failed for ${event._id}: ${ackErr.message}`));
            }
          }
          continue;
        }
        const [event] = group;
        let result;
        if (wasEventHandled(agentName, event._id)) {
          result = { outcome: 'no_action', reason: 'duplicate-delivery' };
          log(`[${event.type}] duplicate delivery ${event._id} — skipping spawn and re-acking`);
        } else {
          const eventWillSpawn = Boolean(extractPrompt(event) && (event.podId || podId));
          try {
            result = await processEvent(event);
          } catch (err) {
            // Do not record or ack: the kernel must retain the event for
            // at-least-once delivery. Stop this fetched batch immediately —
            // continuing could launch every one of the 10 returned events
            // into the same provider outage before the next poll (#782).
            consecutiveSpawnFailures += 1;
            const retry = spawnRetryPolicy({
              error: err,
              consecutiveFailures: consecutiveSpawnFailures,
              intervalMs,
              jitterRatio: spawnJitterRatio,
            });
            nextPollDelayMs = retry.delayMs;
            const retryIn = formatRetryDelay(retry.delayMs);
            const state = retry.circuitOpen ? 'circuit open' : 'retry scheduled';
            const wrapped = new Error(
              `${event.type} processing failed (${retry.failureClass}; `
              + `${consecutiveSpawnFailures} consecutive) — event ${event._id} remains unacked; `
              + `${state}, next probe in ${retryIn}: ${err.message}`,
              { cause: err },
            );
            Object.assign(wrapped, {
              code: 'agent_spawn_retry_scheduled',
              failureClass: retry.failureClass,
              consecutiveFailures: consecutiveSpawnFailures,
              retryAfterMs: retry.delayMs,
              circuitOpen: retry.circuitOpen,
              eventId: event._id,
            });
            // ONE emission, not two. `wrapped.message` already opens with the
            // event type, so the log copy added a second prefix and a second
            // line of identical text into the same merged stream — enough that
            // `grep -c 'session limit'` returned 8 for 4 failures, and a reader
            // counting hits per event id saw 2 and inferred two deliveries.
            // On 2026-08-18 that count pointed at the wrong cause for #993:
            // two deliveries per event puts `attempts` at 2 and the requeue cap
            // one step away. It did not decide anything — the cap was ruled out
            // from the DB, where a capped event would have left a `failed` row
            // and none existed — but it corroborated the wrong theory, and the
            // doubling had to be spotted by hand before the count could be
            // discounted. A log that inflates is worse than one that is silent,
            // because it argues.
            //
            // Routed to the error channel when a caller provides one, and to
            // the log when it doesn't, so neither contract loses the failure:
            // an embedder that passes no `onError` still sees it, and `agent
            // run` — which always passes one — stops printing it twice.
            if (onError) onError(wrapped);
            else log(`[${event.type}] ${wrapped.message}`);
            break;
          }
          // Only a completed model turn proves the local runtime and delivery
          // path recovered. A malformed/no-destination event is still acked,
          // but must not erase the failure streak without exercising either —
          // and neither may an enforcement stand-down (cascade cap, lost
          // claim), which returns before any spawn happens.
          const stoodDown = result?.reason === 'cascade-cap' || result?.reason === 'claim-held';
          if (eventWillSpawn && !stoodDown) consecutiveSpawnFailures = 0;
          // Record after successful processing but before ack. If the ack
          // fails, the next delivery is skipped and re-acked instead of
          // burning a second model turn for work that already completed.
          recordHandledEvent(agentName, event._id);
        }
        try {
          const deliveryId = event.payload?.deliveryId;
          await client.post(`/api/agents/runtime/events/${event._id}/ack`, {
            result,
            ...(typeof deliveryId === 'string' && deliveryId ? { deliveryId } : {}),
          });
        } catch (ackErr) {
          onError?.(new Error(`Ack failed for ${event._id}: ${ackErr.message}`));
        }
      }
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        consecutiveAuthErrors += 1;
        if (consecutiveAuthErrors >= MAX_AUTH_ERRORS) {
          onError?.(new Error(
            `Runtime token rejected ${consecutiveAuthErrors} times in a row — stopping. `
            + `Run: commonly agent detach ${agentName}`,
          ));
          running = false;
          return;
        }
      } else {
        // TASK-025: everything that is not an auth rejection used to fall
        // through to `onError` with `nextPollDelayMs` still at `intervalMs`,
        // because that variable is only reassigned in the spawn-retry branch
        // above and a failed fetch never reaches it. So a network outage
        // retried flat at the poll interval, forever, with one indistinct
        // line per attempt — 797 consecutive `fetch failed` across three
        // seats, ~66 minutes, and nothing that read as an outage.
        //
        // Deliberately NOT a stop. `MAX_AUTH_ERRORS` halts because a rejected
        // token cannot heal itself; a network failure usually can, and a seat
        // that stops on one is dead until a human notices.
        consecutivePollFailures += 1;
        const retry = pollRetryPolicy({
          consecutiveFailures: consecutivePollFailures,
          intervalMs,
          jitterRatio: spawnJitterRatio,
        });
        nextPollDelayMs = retry.delayMs;
        if (retry.escalate) {
          log(
            `poll failed ${consecutivePollFailures}x in a row `
            + `(${err?.message || 'unknown error'}) — backing off to `
            + `${formatRetryDelay(retry.delayMs)}`
            + `${retry.atCeiling ? ', at the ceiling' : ''}`,
          );
        }
      }
      onError?.(err);
    }
    if (running) setTimeoutImpl(tick, nextPollDelayMs);
  };

  tick();
  return { stop: () => { running = false; } };
};

// ── init: scaffold a webhook-SDK agent (ADR-006 §Scaffolding) ───────────────

const SUPPORTED_LANGUAGES = ['python'];

// Resolve a repo-relative path from this module, regardless of where the CLI
// is invoked from. agent.js lives at cli/src/commands/agent.js → repo root is
// three levels up. The scaffolder copies the canonical SDK file from the repo
// into the user's cwd; ADR-006 §SDK lives = "live-copy, not dependency".
//
// Removal condition: ADR-006 §Migration path Phase 4 — when the CLI is
// published as `@commonlyai/cli` on npm, the example files won't sit at a
// repo-relative path; we'll need to bundle them into the package at build
// time and resolve via `import.meta.resolve` or a packaged-data lookup.
// Until that phase, repo-relative is the simplest correct answer.
const repoFile = (...parts) => pathResolve(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', ...parts,
);

const SDK_SOURCES = {
  python: {
    sdkSrc: () => repoFile('examples', 'sdk', 'python', 'commonly.py'),
    botSrc: () => repoFile('examples', 'hello-world-python', 'bot.py'),
    sdkOut: 'commonly.py',
    botOut: (name) => `${name}.py`,
    runHint: (name) => `COMMONLY_TOKEN=$(cat .commonly-env) python3 ${name}.py`,
  },
};

/**
 * Scaffold a webhook-SDK agent into `targetDir`. Pure core — the commander
 * action wraps this with config loading, install + token-mint, and logging.
 *
 * Refuses to clobber any of the three output files. Self-serve install
 * (ADR-006 §Self-serve install) makes publish unnecessary.
 */
export const performInit = async ({
  client,
  language,
  agentName,
  podId,
  displayName,
  targetDir,
}) => {
  const recipe = SDK_SOURCES[language];
  if (!recipe) {
    throw new Error(
      `Unsupported language "${language}". Supported: ${SUPPORTED_LANGUAGES.join(', ')}`,
    );
  }

  const sdkOutPath = join(targetDir, recipe.sdkOut);
  const botOutPath = join(targetDir, recipe.botOut(agentName));
  const tokenOutPath = join(targetDir, '.commonly-env');

  for (const f of [sdkOutPath, botOutPath, tokenOutPath]) {
    if (existsSync(f)) {
      throw new Error(`Refusing to overwrite existing file: ${f}`);
    }
  }

  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  // Copy the SDK file verbatim; copy the bot template byte-for-byte (the
  // user renames their handler later — file name carries the agent name).
  writeFileSync(sdkOutPath, readFileSync(recipe.sdkSrc(), 'utf8'), 'utf8');
  writeFileSync(botOutPath, readFileSync(recipe.botSrc(), 'utf8'), 'utf8');

  // Self-serve install (ADR-006). No publish step; the backend synthesizes
  // an ephemeral registry row when no manifest exists for this name.
  const installResult = await client.post('/api/registry/install', {
    agentName,
    podId,
    displayName: displayName || agentName,
    version: '1.0.0',
    config: { runtime: { runtimeType: 'webhook', host: 'byo' } },
    scopes: ['context:read', 'messages:write', 'memory:read', 'memory:write'],
  });
  const installation = installResult.installation || installResult;
  const instanceId = installation.instanceId || 'default';

  let runtimeToken = installResult.runtimeToken;
  if (!runtimeToken) {
    // ADR-005 §detach + reattach: pass force:true so the server clears the
    // hashed-but-unrecoverable prior token and mints fresh.
    const tokenData = await client.post(
      `/api/registry/pods/${podId}/agents/${agentName}/runtime-tokens`,
      { force: true },
    );
    runtimeToken = tokenData.token;
  }
  if (!runtimeToken) {
    throw new Error('Runtime token was not returned by install or tokens endpoint');
  }

  // .commonly-env uses KEY=VALUE format so `source .commonly-env`, dotenv,
  // and standard env-loading tools work out of the box. Future keys (e.g.
  // COMMONLY_BASE_URL) just append. Mode 0600 (POSIX) since the file holds
  // a long-lived bearer token.
  writeFileSync(tokenOutPath, `COMMONLY_TOKEN=${runtimeToken}\n`,
    { encoding: 'utf8', mode: 0o600 });

  return {
    installation,
    instanceId,
    runtimeToken,
    files: {
      sdk: sdkOutPath,
      bot: botOutPath,
      env: tokenOutPath,
    },
    runHint: recipe.runHint(agentName),
  };
};

// ── detach: uninstall a local-CLI-wrapped agent (ADR-005) ───────────────────

/**
 * Uninstall the agent from its pod AND clean up local token + session files.
 *
 * The three pieces of state created by `attach` are removed in this order:
 *   1. Backend: AgentInstallation (DELETE /api/registry/agents/:name/pods/:podId
 *      marks uninstalled, deletes AgentProfile, removes agent User from pod).
 *      The runtime token tied to the User row is GC'd by the cleanup service
 *      7 days after all installs go inactive — we don't force-revoke here
 *      because the token may legitimately still be in use for another pod.
 *   2. Local token file at ~/.commonly/tokens/<name>.json
 *   3. Local session + handled-event stores at
 *      ~/.commonly/sessions/<name>{,.events}.json
 *
 * Idempotent: if the backend returns 404 (already uninstalled elsewhere), we
 * still clean up local files so the CLI state stays in sync with reality.
 * `--force` / `skipBackend:true` short-circuits to local-only cleanup for
 * the case where the backend has already been uninstalled via another path.
 */
export const performDetach = async ({
  client,
  agentName,
  podId,
  skipBackend = false,
  log = () => {},
}) => {
  if (!agentName || (!skipBackend && !podId)) {
    // A corrupted token file could leave us without a podId; without this
    // guard `encodeURIComponent(undefined)` produces a request against
    // `/pods/undefined` that the backend 404s, silently succeeding.
    throw new Error(
      'performDetach requires agentName (and podId unless skipBackend=true)',
    );
  }

  let backendResult = { skipped: true };
  if (!skipBackend) {
    try {
      const body = await client.del(`/api/registry/agents/${encodeURIComponent(agentName)}/pods/${encodeURIComponent(podId)}`);
      backendResult = { skipped: false, body };
      log(`backend: uninstalled '${agentName}' from pod ${podId}`);
    } catch (err) {
      // 404 means "already gone" — continue to local cleanup.
      if (err.status === 404) {
        backendResult = { skipped: false, alreadyGone: true };
        log(`backend: '${agentName}' already uninstalled from pod ${podId}`);
      } else {
        // Re-throw anything else (403 auth, 500, network) — caller decides.
        throw err;
      }
    }
  }

  deleteAgentToken(agentName);
  clearSessions(agentName);
  log(`local: removed token file + session store for '${agentName}'`);

  return { backend: backendResult, localCleaned: true };
};

/**
 * Every line a seat emits lands in one file, because the fleet is launched as
 * `nohup commonly agent run <name> > <log> 2>&1`. Until now none of those lines
 * carried a time.
 *
 * That is not a cosmetic gap. On 2026-08-18 a fleet-wide quota stall destroyed
 * 38 queued events (#993), and the seat log was the ONLY surviving trace —
 * the kernel rows were deleted, so nothing else recorded that those turns had
 * been attempted. The log records `(4 consecutive)` and `next probe in 2.0m`
 * and gives no way to place either on a clock: the investigation had to date
 * events by decoding ObjectId prefixes instead, because the file that named
 * them could not say when.
 *
 * ISO-8601 so stamps sort lexically, diff cleanly, and line up with the
 * kernel's own timestamps without conversion.
 */
const stamp = () => new Date().toISOString();

/**
 * Map `agent run`'s cascade flags onto resolveCascadeSettings' override keys.
 *
 * Exported because the mapping is where the flag path can go wrong invisibly:
 * an earlier version coerced with Number() here, so `--cascade-cap abc`
 * reached the resolver as NaN and the warning read `--cascade-cap='NaN'` —
 * naming a value the user never typed, on the one line whose whole job is to
 * tell them which input was bad. The values pass through RAW; the resolver is
 * the only thing that parses, for the same reason it is the only thing that
 * validates.
 */
export const cascadeOverridesFromOpts = (opts = {}) => ({
  cascadeCap: opts.cascadeCap,
  cascadeAddressedGrace: opts.cascadeGrace,
  cascadeResetMs: opts.cascadeReset,
});

export const registerAgent = (program) => {
  const agent = program.command('agent').description('Manage agents');

  agent.addHelpText('after', `
Examples:
  # Wrap your local claude binary as a pod agent (ADR-005)
  $ commonly agent attach claude --pod <podId> --name my-claude
  $ commonly agent run my-claude
  $ commonly agent detach my-claude

  # Scaffold a custom Python agent (ADR-006)
  $ commonly agent init --language python --name research-bot --pod <podId>

  # List installed agents
  $ commonly agent list

Docs:
  https://github.com/Team-Commonly/commonly/blob/main/docs/agents/LOCAL_CLI_WRAPPER.md
  https://github.com/Team-Commonly/commonly/blob/main/docs/agents/WEBHOOK_SDK.md
`);

  // ── register ──────────────────────────────────────────────────────────────
  agent
    .command('register')
    .description('Register a webhook agent')
    .requiredOption('--name <name>', 'Agent name (e.g. my-agent)')
    .requiredOption('--pod <podId>', 'Pod ID to install into')
    .requiredOption('--webhook <url>', 'Webhook URL (e.g. https://my-agent.example.com/cap)')
    .option('--secret <secret>', 'Webhook signing secret (HMAC-SHA256)')
    .option('--display <name>', 'Display name shown in the pod')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (opts) => {
      const instanceUrl = resolveInstanceUrl(opts.instance);
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: instanceUrl, token });

      try {
        // Publish the agent definition if it doesn't exist yet.
        await client.post('/api/registry/publish', {
          manifest: {
            name: opts.name,
            version: '1.0.0',
            description: 'A webhook-connected agent.',
            runtimeType: 'webhook',
          },
          displayName: opts.display || opts.name,
        }).catch(() => {
          // Ignore publish errors — agent may already exist, install will proceed
        });

        const result = await client.post('/api/registry/install', {
          agentName: opts.name,
          podId: opts.pod,
          displayName: opts.display || opts.name,
          version: '1.0.0',
          config: {
            runtime: {
              runtimeType: 'webhook',
              host: 'byo',
              webhookUrl: opts.webhook,
              ...(opts.secret ? { webhookSecret: opts.secret } : {}),
            },
          },
          scopes: ['context:read', 'messages:write', 'memory:read'],
        });

        const installation = result.installation || result;
        const instId = installation.instanceId || 'default';
        console.log(`Agent registered: ${installation.agentName} (${instId})`);
        console.log(`Pod: ${opts.pod}`);
        console.log(`Webhook: ${opts.webhook}`);

        // Fetch runtime token for agent connect
        let runtimeToken = result.runtimeToken;
        if (!runtimeToken) {
          try {
            const tokenData = await client.post(
              `/api/registry/pods/${opts.pod}/agents/${opts.name}/runtime-tokens`,
              { force: true },
            );
            runtimeToken = tokenData.token;
          } catch {
            // non-fatal — user can fetch manually
          }
        }
        if (runtimeToken) {
          console.log(`\nRuntime token: ${runtimeToken}`);
          console.log('Use this with: commonly agent connect --name <name> --token <token>');
        }
      } catch (err) {
        console.error(`Registration failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── connect ───────────────────────────────────────────────────────────────
  agent
    .command('connect')
    .description('Start local dev loop — poll events and forward to localhost')
    .requiredOption('--name <name>', 'Agent name')
    .option('--port <port>', 'Local webhook server port', '3001')
    .option('--path <path>', 'Local webhook path', '/cap')
    .option('--secret <secret>', 'Signing secret to verify forwarded events')
    .option('--token <token>', 'Agent runtime token (cm_agent_*) — use instead of user token for event polling')
    .option('--instance-id <id>', 'Instance ID (default: "default")', 'default')
    .option('--instance <url>', 'Target Commonly instance')
    .option('--interval <ms>', 'Poll interval in ms', '5000')
    .action(async (opts) => {
      const instanceUrl = resolveInstanceUrl(opts.instance);
      const token = opts.token || getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const port = parseInt(opts.port, 10);
      const localUrl = `http://localhost:${port}${opts.path}`;

      console.log(`Connecting ${opts.name} → ${instanceUrl}`);
      console.log(`Forwarding events to ${localUrl}`);
      console.log('Waiting for events... (Ctrl+C to stop)\n');

      // Start local webhook server
      const { close } = await startWebhookServer({
        port,
        path: opts.path,
        secret: opts.secret,
        onEvent: async (event) => {
          // Developer's agent code handles this — just ack locally
          console.log(`[local] ${event.type} from pod ${event.podId}`);
          return { outcome: 'acknowledged' };
        },
        onReady: (url) => console.log(`Local server ready: ${url}`),
      });

      // Start poller — forwards each event to the local server
      const poller = startPoller({
        instanceUrl,
        token,
        agentName: opts.name,
        instanceId: opts.instanceId,
        intervalMs: parseInt(opts.interval, 10),
        onEvent: async (event) => {
          const ts = new Date().toTimeString().slice(0, 8);
          process.stdout.write(`[${ts}] ${event.type.padEnd(18)}`);

          try {
            const result = await forwardToLocalWebhook(event, localUrl, opts.secret);
            console.log(`→ ${result.outcome}`);
            return result;
          } catch (err) {
            console.log(`→ error (${err.message})`);
            return { outcome: 'error', reason: err.message };
          }
        },
        onError: (err) => {
          console.error(`[poll error] ${err.message}`);
        },
      });

      // Graceful shutdown
      process.on('SIGINT', () => {
        console.log('\nStopping...');
        poller.stop();
        close();
        process.exit(0);
      });
    });

  // ── attach (ADR-005, ADR-008) ─────────────────────────────────────────────
  agent
    .command('attach <adapter>')
    .description('Wrap a local CLI as a Commonly agent (stub|claude|codex|…)')
    .requiredOption('--pod <podId>', 'Pod ID to install into')
    .requiredOption('--name <name>', 'Agent name (e.g. my-claude)')
    .option('--display <name>', 'Display name shown in the pod')
    .option('--env <path>', 'Path to environment.json (ADR-008 — sandbox/skills/MCP)')
    .option('--import-memory [path]', 'Import local memory (CLAUDE.md / MEMORY.md / ~/.claude project memory, or a given file/dir) into the agent after attach')
    .option('--yes', 'Skip the import confirmation prompt')
    .option('--wake-on-message', 'Wake this agent on every message in the pod, not only @mentions (ADR-018 ambient wake; default off). Change later with: commonly agent wake <name> on|off')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (adapterName, opts) => {
      const instanceUrl = resolveInstanceUrl(opts.instance);
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: instanceUrl, token });

      try {
        const envAbsPath = opts.env ? pathResolve(opts.env) : null;
        const {
          installation, instanceId, runtimeToken, detected, wrappedCli,
          environment, workspace,
        } = await performAttach({
          client,
          adapterName,
          agentName: opts.name,
          podId: opts.pod,
          displayName: opts.display,
          envPath: envAbsPath,
          wakeOnMessage: Boolean(opts.wakeOnMessage),
          log: (line) => console.warn(`[attach] ${line}`),
        });

        saveAgentToken(opts.name, {
          agentName: opts.name,
          instanceId,
          podId: opts.pod,
          instanceUrl,
          runtimeToken,
          adapter: wrappedCli,
          ...(environment ? {
            environment,
            workspacePath: workspace?.path || null,
          } : {}),
        });

        console.log(`✓ ${wrappedCli} detected at ${detected.path} (${detected.version})`);
        console.log(`✓ Agent '${installation.agentName}' registered in pod ${opts.pod} (${instanceId})`);
        console.log(`✓ Runtime token saved to ${tokenFile(opts.name)}`);
        if (workspace) {
          console.log(`✓ Workspace: ${workspace.path}${workspace.created ? ' (created)' : ''}`);
        }
        if (opts.wakeOnMessage) {
          console.log('✓ Wake-on-message: ON (sees every pod message; answers only when addressed or genuinely useful)');
        }

        // Retention plan Phase C: the agent arrives whole. Import failure is
        // a warning, never an attach failure — the attach already succeeded
        // and `commonly agent import-memory` can retry later.
        if (opts.importMemory) {
          try {
            const runtimeClient = createClient({ instance: instanceUrl, token: runtimeToken });
            await runMemoryImport({
              client: runtimeClient,
              explicitPath: typeof opts.importMemory === 'string' ? pathResolve(opts.importMemory) : null,
              yes: Boolean(opts.yes),
            });
          } catch (err) {
            console.warn(`Memory import failed (agent is still attached): ${err.message}`);
            console.warn(`Retry with: commonly agent import-memory ${opts.name}`);
          }
        }

        // The mention handle is the instanceId (what the UI dropdown inserts),
        // not the registry agentName — say it here so users know how to ping it.
        const handle = instanceId && instanceId !== 'default' ? instanceId : installation.agentName;
        console.log(`\n  Run with:    commonly agent run ${opts.name}`);
        console.log(`  Mention as:  @${handle}`);
      } catch (err) {
        console.error(`Attach failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── import-memory (retention plan Phase C) ────────────────────────────────
  agent
    .command('import-memory <name>')
    .description("Import local memory (CLAUDE.md / MEMORY.md / ~/.claude project memory) into an attached agent's long_term memory")
    .option('--path <path>', 'Import a specific file or directory of .md files instead of auto-detecting')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (name, opts) => {
      const record = loadAgentToken(name);
      if (!record) {
        console.error(`No token for '${name}'. Attach it first: commonly agent attach <adapter> --pod <podId> --name ${name}`);
        process.exit(1);
      }
      try {
        const client = createClient({ instance: record.instanceUrl, token: record.runtimeToken });
        const result = await runMemoryImport({
          client,
          explicitPath: opts.path ? pathResolve(opts.path) : null,
          yes: Boolean(opts.yes),
        });
        if (!result.imported && result.reason === 'needs-confirmation') process.exit(1);
      } catch (err) {
        console.error(`Import failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── import-skills (retention plan Phase C — metadata only) ────────────────
  agent
    .command('import-skills <name>')
    .description("Register a local agent's skills (names + descriptions only) on its Commonly profile — content stays on your machine")
    .option('--dir <path>', 'Skills directory (default: <cwd>/.claude/skills, then ~/.claude/skills)')
    .option('--yes', 'Skip the confirmation prompt')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (name, opts) => {
      const record = loadAgentToken(name);
      if (!record) {
        console.error(`No token for '${name}'. Attach it first: commonly agent attach <adapter> --pod <podId> --name ${name}`);
        process.exit(1);
      }
      // Skill registration is a USER action (pod-membership-checked route),
      // unlike memory import which authenticates as the agent.
      const userToken = getToken(opts.instance);
      if (!userToken) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      try {
        const skills = detectSkills({ explicitDir: opts.dir ? pathResolve(opts.dir) : null });
        if (!skills.length) {
          console.log('No skills found (looked for */SKILL.md under .claude/skills). Pass --dir to point at a skills directory.');
          return;
        }
        console.log(`Found ${skills.length} skill${skills.length === 1 ? '' : 's'}:`);
        for (const s of skills) {
          console.log(`  ${s.name}${s.description ? ` — ${s.description.slice(0, 80)}` : ''}`);
        }
        console.log('\nOnly names + descriptions are uploaded — skill content stays on this machine.');

        if (!opts.yes) {
          if (!process.stdin.isTTY) {
            console.log('Not a terminal — re-run with --yes to confirm.');
            process.exit(1);
          }
          const { createInterface } = await import('readline/promises');
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(`Register on ${record.agentName}'s profile? [y/N] `);
          rl.close();
          if (!/^y(es)?$/i.test(answer.trim())) {
            console.log('Cancelled.');
            return;
          }
        }

        const client = createClient({ instance: record.instanceUrl, token: userToken });
        const result = await importSkills(client, {
          skills,
          podId: record.podId,
          agentName: record.agentName,
          instanceId: record.instanceId || 'default',
        });
        console.log(`✓ Registered ${result.imported} skill${result.imported === 1 ? '' : 's'} on ${record.agentName}'s profile.`);
      } catch (err) {
        console.error(`Skills import failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── run (ADR-005) ─────────────────────────────────────────────────────────
  agent
    .command('run <name>')
    .description('Run the local-CLI wrapper loop for an attached agent')
    .option('--interval <ms>', 'Poll interval in ms', '5000')
    .option('--adapter <name>', 'CLI to wrap on first-run bootstrap (claude|codex); ignored when a token file already exists')
    .option('--cascade-cap <n>', `Consecutive agent-triggered turns allowed per pod (env ${CASCADE_ENV_VARS.cap}, default ${CASCADE_DEFAULTS.cap})`)
    .option('--cascade-grace <n>', `Extra turns allowed when this seat was directly addressed; 0 disables the grace (env ${CASCADE_ENV_VARS.addressedGrace}, default ${CASCADE_DEFAULTS.addressedGrace})`)
    .option('--cascade-reset <ms>', `Silence window that clears the streak (env ${CASCADE_ENV_VARS.resetMs}, default ${CASCADE_DEFAULTS.resetMs})`)
    .action(async (name, opts) => {
      let record = loadAgentToken(name);
      if (!record) {
        // First run on this machine: the BYO connect page hands out env vars,
        // not a token file — bootstrap the record from them (#913).
        try {
          record = await bootstrapAgentRecordFromEnv({
            name,
            adapterOverride: opts.adapter || null,
            log: (line) => console.log(`${stamp()} [${name}] ${line}`),
          });
        } catch (err) {
          console.error(`${stamp()} [${name}] ${err.message}`);
          process.exit(1);
        }
        if (record) {
          saveAgentToken(record.agentName, record);
          console.log(`${stamp()} [${name}] bootstrapped ${tokenFile(record.agentName)} from COMMONLY_AGENT_TOKEN (adapter: ${record.adapter})`);
        } else {
          console.error(
            `No token for '${name}'. Either export COMMONLY_API_URL + COMMONLY_AGENT_TOKEN`
            + ` (shown on the Connect your own agent page) and re-run, or:`
            + ` commonly agent attach <adapter> --pod <podId> --name ${name}`,
          );
          process.exit(1);
        }
      }

      const adapter = getAdapter(record.adapter);
      if (!adapter) {
        console.error(`Unknown adapter '${record.adapter}' in token file. Known: ${listAdapterNames().join(', ')}`);
        process.exit(1);
      }

      // THE line to stamp, not just one of them. It is the first line of every
      // seat log and the truncation boundary — the fleet is launched as
      // `nohup … > log 2>&1`, so this banner is written at boot and everything
      // before it is gone. Stamped, it dates the restart from the log itself.
      // Unstamped, it took `ps -o lstart` to establish when nine seats came
      // back on 2026-08-18, and that only worked because the processes were
      // still alive — after the next restart that route is gone too.
      console.log(`${stamp()} [${name}] polling ${record.instanceUrl} for events (ctrl+c to stop)`);

      const { stop } = performRun({
        instanceUrl: record.instanceUrl,
        token: record.runtimeToken,
        adapter,
        agentName: record.agentName,
        instanceId: record.instanceId,
        podId: record.podId,
        environment: record.environment || null,
        workspacePath: record.workspacePath || null,
        intervalMs: parseInt(opts.interval, 10),
        ...cascadeOverridesFromOpts(opts),
        log: (line) => console.log(`${stamp()} [${name}] ${line}`),
        // Both sinks are stamped, and both must be — but not for the reason
        // this comment gave until now, which its own PR falsified.
        //
        // A spawn failure is routed to `onError` when a caller provides one and
        // to `log` only as the fallback, so in `agent run` — which always passes
        // one — EVERY failure line comes out of the error channel and none out
        // of the log. Stamping only `log:` would leave the entire failure class
        // undated, which is the class these stamps exist for.
        //
        // The two sinks also carry genuinely different text elsewhere: the
        // no-prompt skip logs a terse line and sends a detailed diagnostic, so
        // one stamped and one bare would date half of that pair.
        //
        // (History, because the reasoning moved twice. This originally argued
        // from a DOUBLE emission — the retry path called both sinks with
        // identical text, so `grep -c 'session limit'` returned 8 for 4 failures
        // and a per-event count read as two deliveries. That was true when the
        // stamps landed and false eleven minutes later, when the same PR
        // collapsed the duplication. The conclusion survived the premise; the
        // sentence did not, and nothing in the diff pointed at it.)
        onError: (err) => console.error(`${stamp()} [${name}] ${err.message}`),
      });

      process.on('SIGINT', () => {
        console.log(`\n${stamp()} [${name}] stopping...`);
        stop();
        process.exit(0);
      });
    });

  // ── detach (ADR-005) ──────────────────────────────────────────────────────
  agent
    .command('detach <name>')
    .description('Uninstall an attached agent from its pod and delete local state')
    .option('--force', 'Skip the backend uninstall call; only remove local files')
    .action(async (name, opts) => {
      const record = loadAgentToken(name);
      if (!record) {
        console.error(
          `No local state for '${name}'. If the agent is still installed on `
          + `the backend, uninstall it via the Agent Hub UI or:\n`
          + `  curl -X DELETE <instance>/api/registry/agents/${name}/pods/<podId> \\\n`
          + `    -H "Authorization: Bearer <user JWT>"`,
        );
        process.exit(1);
      }

      try {
        let client = null;
        if (!opts.force) {
          // The DELETE endpoint expects the user's JWT, not the agent runtime
          // token — matches the auth surface of attach/init. We use the saved
          // instanceUrl to find the right user token (getToken accepts URL).
          const userToken = getToken(record.instanceUrl);
          if (!userToken) {
            console.error(
              `No user login found for ${record.instanceUrl}. Either run `
              + `'commonly login --instance ${record.instanceUrl}' first, or `
              + `'commonly agent detach ${name} --force' to clean up local files only.`,
            );
            process.exit(1);
          }
          client = createClient({ instance: record.instanceUrl, token: userToken });
        }

        const result = await performDetach({
          client,
          agentName: record.agentName,
          podId: record.podId,
          skipBackend: !!opts.force,
          log: (line) => console.warn(`[detach] ${line}`),
        });

        if (opts.force) {
          console.log(`✓ Removed local state for '${name}' (backend NOT notified)`);
        } else if (result.backend?.alreadyGone) {
          console.log(`✓ '${name}' was already uninstalled from pod ${record.podId}; cleaned local state`);
        } else {
          console.log(`✓ Detached '${name}' from pod ${record.podId} and removed local state`);
        }
      } catch (err) {
        console.error(`Detach failed: ${err.message}`);
        console.error(`If the backend is unreachable, retry with --force to clean up local files.`);
        process.exit(1);
      }
    });

  // ── init (ADR-006) ────────────────────────────────────────────────────────
  agent
    .command('init')
    .description('Scaffold a webhook-SDK agent into the current directory')
    .requiredOption('--language <lang>', `One of: ${SUPPORTED_LANGUAGES.join(', ')}`)
    .requiredOption('--name <name>', 'Agent name (e.g. research-bot)')
    .requiredOption('--pod <podId>', 'Pod ID to install into')
    .option('--display <name>', 'Display name shown in the pod')
    .option('--dir <path>', 'Target directory (default: current dir)')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (opts) => {
      const instanceUrl = resolveInstanceUrl(opts.instance);
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: instanceUrl, token });

      try {
        const result = await performInit({
          client,
          language: opts.language,
          agentName: opts.name,
          podId: opts.pod,
          displayName: opts.display,
          targetDir: pathResolve(opts.dir || process.cwd()),
        });

        console.log(`✓ Written: ${result.files.bot}`);
        console.log(`✓ Written: ${result.files.sdk}`);
        console.log(`✓ Registered '${opts.name}' in pod ${opts.pod} (${result.instanceId})`);
        console.log(`✓ Runtime token saved to ${result.files.env}`);
        console.log('\nNext:');
        console.log(`  1. Edit ${opts.name}.py to handle events.`);
        console.log(`  2. Run: ${result.runHint}`);
      } catch (err) {
        console.error(`Init failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── list ──────────────────────────────────────────────────────────────────
  agent
    .command('list')
    .description('List agents — installed on backend (default) or attached locally (--local)')
    .option('--local', 'List agents attached on this laptop (~/.commonly/tokens/)')
    .option('--pod <podId>', 'Filter by pod (backend mode only)')
    .option('--instance <url>', 'Target Commonly instance (backend mode only)')
    .addHelpText('after', `
The two modes answer different questions:

  backend (default)  — who is installed in pods I can see, on any driver
  --local            — who have I attached on THIS laptop via 'agent attach'

Use --local to find the name you'd pass to 'agent run' or 'agent detach'.
`)
    .action(async (opts) => {
      if (opts.local) {
        const agents = listLocalAgents();
        if (agents.length === 0) {
          console.log('No agents attached locally. Run: commonly agent attach <adapter> --pod <podId> --name <n>');
          return;
        }
        const col = (s, w) => String(s ?? '').padEnd(w).slice(0, w);
        console.log(`${col('NAME', 20)} ${col('ADAPTER', 10)} ${col('POD', 26)} LAST TURN`);
        console.log('─'.repeat(80));
        agents.forEach((a) => {
          const lastTurn = a.lastTurn ? new Date(a.lastTurn).toLocaleString() : 'never';
          console.log(`${col(a.name, 20)} ${col(a.adapter, 10)} ${col(a.podId, 26)} ${lastTurn}`);
        });
        return;
      }

      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: resolveInstanceUrl(opts.instance), token });

      try {
        const params = opts.pod ? { podId: opts.pod } : {};
        const data = await client.get('/api/registry/admin/installations', params);
        const installations = data.installations || data || [];

        if (installations.length === 0) {
          console.log('No agents installed.');
          return;
        }

        const col = (s, w) => String(s ?? '').padEnd(w).slice(0, w);
        console.log(`${col('NAME', 16)} ${col('INSTANCE', 10)} ${col('RUNTIME', 14)} ${col('HOST', 6)} ${col('STATUS', 10)} LAST SEEN`);
        console.log('─'.repeat(80));
        installations.forEach((inst) => {
          const runtimeType = inst.config?.runtime?.runtimeType || inst.runtimeType || '?';
          const host = inst.config?.runtime?.host || '';
          const lastSeen = inst.usage?.lastUsedAt
            ? new Date(inst.usage.lastUsedAt).toLocaleString()
            : 'never';
          console.log(`${col(inst.agentName, 16)} ${col(inst.instanceId, 10)} ${col(runtimeType, 14)} ${col(host, 6)} ${col(inst.status, 10)} ${lastSeen}`);
        });
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── logs ──────────────────────────────────────────────────────────────────
  agent
    .command('logs <name>')
    .description('Stream recent events for an agent')
    .option('--instance-id <id>', 'Instance ID', 'default')
    .option('--follow', 'Keep polling for new events', false)
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (name, opts) => {
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: resolveInstanceUrl(opts.instance), token });

      const fetchAndPrint = async () => {
        const { events = [] } = await client.get('/api/agents/runtime/events', {
          agentName: name,
          instanceId: opts.instanceId,
          limit: 20,
        });
        events.forEach((e) => {
          const ts = new Date(e.createdAt).toTimeString().slice(0, 8);
          const outcome = e.delivery?.outcome || e.status;
          console.log(`[${ts}] ${e.type.padEnd(18)} → ${outcome}`);
        });
        return events;
      };

      try {
        await fetchAndPrint();
        if (opts.follow) {
          console.log('Following... (Ctrl+C to stop)');
          setInterval(fetchAndPrint, 5000);
        }
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── wake (ADR-018 ambient wake toggle) ───────────────────────────────────
  agent
    .command('wake <name> <on|off>')
    .description('Turn wake-on-message on/off for an attached agent (off = @mentions and heartbeats only)')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (name, state, opts) => {
      const enabled = state === 'on';
      if (!enabled && state !== 'off') {
        console.error(`Expected "on" or "off", got "${state}"`);
        process.exit(1);
      }
      const record = loadAgentToken(name);
      if (!record) {
        console.error(`No token file for '${name}' — is it attached on this machine? (commonly agent list --local)`);
        process.exit(1);
      }
      const instanceUrl = resolveInstanceUrl(opts.instance || record.instanceUrl);
      const token = getToken(opts.instance || record.instanceUrl);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }
      const client = createClient({ instance: instanceUrl, token });
      try {
        const result = await setWakeOnMessage({ client, record, enabled });
        console.log(`✓ Wake-on-message ${result.enabled ? 'ON' : 'OFF'} for ${result.agentName} in pod ${result.podId}`);
        console.log(result.enabled
          ? '  The agent now sees every message in the pod; its runtime decides whether to answer (NO_REPLY otherwise). No restart needed.'
          : '  The agent now wakes only on @mentions, replies to it, and heartbeats. No restart needed.');
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── heartbeat ─────────────────────────────────────────────────────────────
  agent
    .command('heartbeat <name>')
    .description('Manually trigger an agent heartbeat')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (name, opts) => {
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: resolveInstanceUrl(opts.instance), token });

      try {
        await client.post(`/api/registry/admin/agents/${name}/trigger-heartbeat`, {});
        console.log(`Heartbeat triggered for ${name}`);
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }
    });
};
