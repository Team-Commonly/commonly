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
import { getSession, setSession, clearSessions } from '../lib/session-store.js';
import { readLongTerm, syncBack } from '../lib/memory-bridge.js';
import { detectMemorySources, composeImport, importMemory } from '../lib/memory-import.js';
import { detectSkills, importSkills } from '../lib/skills-import.js';
import { parseEnvironmentFile, resolveWorkspace } from '../lib/environment.js';
import { detectBwrap } from '../lib/sandbox/bwrap.js';

// ── Token file I/O — ~/.commonly/tokens/<name>.json (ADR-005) ───────────────

const tokensDir = () => join(homedir(), '.commonly', 'tokens');
const tokenFile = (name) => join(tokensDir(), `${name}.json`);

export const saveAgentToken = (name, record) => {
  if (!existsSync(tokensDir())) mkdirSync(tokensDir(), { recursive: true });
  writeFileSync(
    tokenFile(name),
    JSON.stringify({ ...record, savedAt: new Date().toISOString() }, null, 2),
    'utf8',
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

// Event types that carry a prompt the wrapper should forward to the CLI.
// Other event types (heartbeat, delivery, etc.) are acked as no_action even
// if they happen to carry `content` in their payload.
const PROMPT_EVENT_TYPES = new Set([
  'chat.mention',
  'message.posted',
  'dm.message',
  'first_contact',
]);

// ── default environment for adapters that benefit from auto-MCP wiring ─────

// Adapters that can consume `mcp[]` from the resolved environment spec.
// `claude` reads it via --mcp-config (see adapters/claude.js); `codex` via
// `-c mcp_servers.*` config overrides (see adapters/codex.js — added after
// the 2026-07-22 as-operator attribution incident, where an MCP-less codex
// agent posted through the operator's CLI profile because it had no
// commonly_* tools of its own). `stub` does not. Returning null means "no
// default" — the wrapper proceeds with environment=null exactly like before.
const ADAPTERS_WITH_DEFAULT_MCP = new Set(['claude', 'codex']);

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
  // package that dropped the skills/ dir shouldn't hand linkSkills a
  // missing-source path every spawn).
  if (existsSync(BUNDLED_COMMONLY_SKILL_DIR)) {
    environment.skills = { claude: [BUNDLED_COMMONLY_SKILL_DIR] };
  }
  return environment;
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
    } else if (sandboxMode !== 'none' && sandboxMode !== undefined) {
      throw new Error(
        `sandbox.mode=${sandboxMode} is not yet implemented in the local-CLI driver. `
        + `Phase 1 supports: none, bwrap.`,
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
  if (!PROMPT_EVENT_TYPES.has(event.type)) return null;
  const p = event.payload || {};
  return p.content || p.prompt || p.text || null;
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

  // Adapters default `ctx.cwd` to this path. Node's child_process.spawn
  // rejects with "spawn <bin> ENOENT" when cwd does not exist — same shape
  // as binary-not-found — so we ensure it up front to avoid the confusing
  // diagnostic. ADR-008: when an environment spec was attached, the resolved
  // workspace path replaces the /tmp default.
  const agentCwd = workspacePath || join(tmpdir(), 'commonly-agents', agentName);
  if (!existsSync(agentCwd)) mkdirSync(agentCwd, { recursive: true });

  const processEvent = async (event) => {
    const eventPodId = event.podId || podId;
    const prompt = extractPrompt(event);
    if (!prompt || !eventPodId) {
      // No prompt, or nowhere to post the response — skip spawn entirely so
      // we never consume a CLI turn for a message with no destination.
      log(`[${event.type}] no prompt — no-op`);
      return { outcome: 'no_action' };
    }

    const sessionId = getSession(agentName, eventPodId);
    // ADR-005 §Memory bridge: read long_term before spawn, inject via ctx,
    // and (if the adapter returns a summary) patch-sync back after.
    const memoryLongTerm = await readLongTerm(client, { onError });

    // Snapshot the pod's recent messages so that, after the spawn, we can
    // tell whether the agent posted itself via commonly_post_message. If it
    // did, its final CLI text is a narration/log — echoing it would duplicate
    // the message and re-fire any @mention. This is the wrapper-side guarantee
    // that a deliberate multi-post ("on it…" then "…done") is never doubled,
    // without relying on the agent to emit NO_REPLY. (A rare concurrent post by
    // another member during the spawn window can suppress a genuine wrapper
    // reply — an acceptable trade against a guaranteed double-post.)
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
    const preSpawn = await snapshotMessages();
    const preSpawnIds = preSpawn
      ? new Set(preSpawn.map((m) => String(m._id || m.id)))
      : null;

    log(`[${event.type}] spawning ${adapter.name}`);
    const result = await adapter.spawn(prompt, {
      sessionId,
      cwd: agentCwd,
      env: process.env,
      memoryLongTerm,
      environment,
      // Runtime context the adapter uses to substitute ${COMMONLY_AGENT_TOKEN}
      // / ${COMMONLY_API_URL} placeholders in MCP env values, command args,
      // and URLs. Lets users keep tokens out of their checked-in env files.
      runtimeToken: token,
      instanceUrl,
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
    if (preSpawnIds) {
      const postSpawn = await snapshotMessages();
      if (postSpawn) {
        for (const m of postSpawn) {
          // Only a NEW message from a bot user counts as "the agent posted
          // itself". A new human-authored message must NOT suppress the echo:
          // it is either a human typing mid-turn, or the agent misusing an
          // operator CLI profile / human token (the 2026-07-22 as-operator
          // attribution incident) — in both cases the wrapper still delivers
          // the reply under the agent's own identity.
          if (!preSpawnIds.has(String(m._id || m.id)) && m.isBot) {
            agentPostedItself = true;
            break;
          }
        }
      }
    }
    if (!replyText || replyText === 'NO_REPLY') {
      log(`[${event.type}] no wrapper-post (${replyText === 'NO_REPLY' ? 'NO_REPLY' : 'empty output'})`);
    } else if (agentPostedItself) {
      log(`[${event.type}] agent posted via tool this turn — not echoing CLI output (avoids double-post)`);
    } else {
      await client.post(`/api/agents/runtime/pods/${eventPodId}/messages`, {
        content: replyText,
      });
      log(`[${event.type}] posted ${Buffer.byteLength(replyText)} bytes`);
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
    return { outcome: 'posted' };
  };

  const tick = async () => {
    if (!running) return;
    try {
      const { events = [] } = await client.get('/api/agents/runtime/events', {
        agentName, instanceId, limit: 10,
      });
      consecutiveAuthErrors = 0;
      for (const event of events) {
        if (!running) break;
        let result;
        try {
          result = await processEvent(event);
        } catch (err) {
          // Spawn failed — skip ack, let kernel re-deliver (ADR-005).
          log(`[${event.type}] spawn error: ${err.message}`);
          onError?.(err);
          continue;
        }
        try {
          await client.post(`/api/agents/runtime/events/${event._id}/ack`, { result });
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
      }
      onError?.(err);
    }
    if (running) setTimeoutImpl(tick, intervalMs);
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
 *   3. Local session store at ~/.commonly/sessions/<name>.json
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
    .action(async (name, opts) => {
      const record = loadAgentToken(name);
      if (!record) {
        console.error(`No token for '${name}'. Run: commonly agent attach <adapter> --pod <podId> --name ${name}`);
        process.exit(1);
      }

      const adapter = getAdapter(record.adapter);
      if (!adapter) {
        console.error(`Unknown adapter '${record.adapter}' in token file. Known: ${listAdapterNames().join(', ')}`);
        process.exit(1);
      }

      console.log(`[${name}] polling ${record.instanceUrl} for events (ctrl+c to stop)`);

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
        log: (line) => console.log(`[${name}] ${line}`),
        onError: (err) => console.error(`[${name}] ${err.message}`),
      });

      process.on('SIGINT', () => {
        console.log(`\n[${name}] stopping...`);
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
