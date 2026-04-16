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

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
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

// Event types that carry a human/agent-authored prompt the wrapper should
// forward to the CLI. Other event types (heartbeat, delivery, etc.) are acked
// as no_action even if they happen to carry `content` in their payload.
const CHAT_EVENT_TYPES = new Set(['chat.mention', 'message.posted', 'dm.message']);

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

  // Idempotent publish — already-published is expected and fine. Install will
  // surface the real error if the manifest is truly unusable.
  try {
    await client.post('/api/registry/publish', {
      manifest: {
        name: agentName,
        version: '1.0.0',
        description: displayName || agentName,
        runtimeType: 'local-cli',
      },
      displayName: displayName || agentName,
    });
  } catch (err) {
    log(`publish skipped: ${err.message}`);
  }

  // config.runtime is an opaque blob the backend stores verbatim — kernel
  // does not interpret runtimeType here. ADR-004 §Identity's `sourceRuntime`
  // is a different field (memory-sync tag); don't conflate the two.
  const installResult = await client.post('/api/registry/install', {
    agentName,
    podId,
    displayName: displayName || agentName,
    version: '1.0.0',
    config: {
      runtime: {
        runtimeType: 'local-cli',
        wrappedCli: adapter.name,
      },
    },
    scopes: ['context:read', 'messages:write', 'memory:read', 'memory:write'],
  });

  const installation = installResult.installation || installResult;
  const instanceId = installation.instanceId || 'default';

  let runtimeToken = installResult.runtimeToken;
  if (!runtimeToken) {
    const tokenData = await client.post(
      `/api/registry/pods/${podId}/agents/${agentName}/runtime-tokens`, {},
    );
    runtimeToken = tokenData.token;
  }
  if (!runtimeToken) {
    throw new Error('Runtime token was not returned by install or tokens endpoint');
  }

  return { installation, instanceId, runtimeToken, detected, wrappedCli: adapter.name };
};

// ── run: local-CLI wrapper loop (ADR-005) ────────────────────────────────────

const extractPrompt = (event) => {
  if (!CHAT_EVENT_TYPES.has(event.type)) return null;
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
  // diagnostic.
  const agentCwd = join(tmpdir(), 'commonly-agents', agentName);
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
    log(`[${event.type}] spawning ${adapter.name}`);
    const result = await adapter.spawn(prompt, {
      sessionId,
      cwd: agentCwd,
      env: process.env,
      memoryLongTerm,
      metadata: { event },
    });

    if (result.newSessionId) {
      setSession(agentName, eventPodId, result.newSessionId);
    }
    if (result.text) {
      await client.post(`/api/agents/runtime/pods/${eventPodId}/messages`, {
        content: result.text,
      });
      log(`[${event.type}] posted ${Buffer.byteLength(result.text)} bytes`);
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
// published as `@commonly/cli` on npm, the example files won't sit at a
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
    config: { runtime: { runtimeType: 'webhook' } },
    scopes: ['context:read', 'messages:write', 'memory:read', 'memory:write'],
  });
  const installation = installResult.installation || installResult;
  const instanceId = installation.instanceId || 'default';

  let runtimeToken = installResult.runtimeToken;
  if (!runtimeToken) {
    const tokenData = await client.post(
      `/api/registry/pods/${podId}/agents/${agentName}/runtime-tokens`, {},
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
        // Publish the agent definition if it doesn't exist yet
        await client.post('/api/registry/publish', {
          manifest: {
            name: opts.name,
            version: '1.0.0',
            description: opts.display || opts.name,
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
              `/api/registry/pods/${opts.pod}/agents/${opts.name}/runtime-tokens`, {},
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

  // ── attach (ADR-005) ──────────────────────────────────────────────────────
  agent
    .command('attach <adapter>')
    .description('Wrap a local CLI as a Commonly agent (stub|claude|codex|…)')
    .requiredOption('--pod <podId>', 'Pod ID to install into')
    .requiredOption('--name <name>', 'Agent name (e.g. my-claude)')
    .option('--display <name>', 'Display name shown in the pod')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (adapterName, opts) => {
      const instanceUrl = resolveInstanceUrl(opts.instance);
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: instanceUrl, token });

      try {
        const { installation, instanceId, runtimeToken, detected, wrappedCli } =
          await performAttach({
            client,
            adapterName,
            agentName: opts.name,
            podId: opts.pod,
            displayName: opts.display,
            log: (line) => console.warn(`[attach] ${line}`),
          });

        saveAgentToken(opts.name, {
          agentName: opts.name,
          instanceId,
          podId: opts.pod,
          instanceUrl,
          runtimeToken,
          adapter: wrappedCli,
        });

        console.log(`✓ ${wrappedCli} detected at ${detected.path} (${detected.version})`);
        console.log(`✓ Agent '${installation.agentName}' registered in pod ${opts.pod} (${instanceId})`);
        console.log(`✓ Runtime token saved to ${tokenFile(opts.name)}`);
        console.log(`\n  Run with: commonly agent run ${opts.name}`);
      } catch (err) {
        console.error(`Attach failed: ${err.message}`);
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
    .description('List installed agents')
    .option('--pod <podId>', 'Filter by pod')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (opts) => {
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
        console.log(`${col('NAME', 16)} ${col('INSTANCE', 10)} ${col('RUNTIME', 10)} ${col('STATUS', 10)} LAST SEEN`);
        console.log('─'.repeat(70));
        installations.forEach((inst) => {
          const runtimeType = inst.config?.runtime?.runtimeType || inst.runtimeType || '?';
          const lastSeen = inst.usage?.lastUsedAt
            ? new Date(inst.usage.lastUsedAt).toLocaleString()
            : 'never';
          console.log(`${col(inst.agentName, 16)} ${col(inst.instanceId, 10)} ${col(runtimeType, 10)} ${col(inst.status, 10)} ${lastSeen}`);
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
