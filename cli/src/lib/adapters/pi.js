/**
 * pi adapter — ADR-005 adapter contract for the pi coding agent
 * (https://pi.dev, `@earendil-works/pi-coding-agent`), the harness that lets
 * a wrapper seat run on any OpenAI-compatible model: DeepSeek through
 * LiteLLM today, anything LiteLLM routes tomorrow.
 *
 * Why a third adapter (2026-09-18): the Luna code-writer seats ran codex on
 * ChatGPT quota, and when that ran out the fleet stalled. codex 0.153 cannot
 * drive DeepSeek — it sends a `namespace`-type tool DeepSeek's API rejects
 * even with every feature flag off — while pi headless on LiteLLM's
 * `deepseek-v4-flash` wrote a file with its `write` tool, ran it with `bash`
 * and resumed its session on the next turn (proof on this laptop, 03:57Z).
 * pi was already the hosted turn engine (ADR-021); this is pi as a wrapper.
 *
 * How pi is driven:
 *   pi -p --mode json --provider <p> --model <m> --thinking <t>
 *      --session-dir <seat dir> (--session-id <uuid> | --session <uuid>)
 *      -e pi-commonly-mcp.mjs "<prompt>"
 *
 *   - `--session-id` creates the session on the first turn; `--session`
 *     resumes it (`--session-id` cannot be combined with `--continue`).
 *   - stdout is NDJSON; the reply is the last assistant `message_end`.
 *   - Provider config is a per-seat models.json under
 *     `~/.commonly/pi-homes/<hash>/agent`, pointed at by
 *     PI_CODING_AGENT_DIR — never the operator's ~/.pi. The API key is an
 *     env reference (`$COMMONLY_LITELLM_KEY`), so it never lands on disk.
 *   - Commonly's tools reach pi through pi-commonly-mcp.mjs, an extension
 *     that speaks MCP over stdio to every server in `environment.mcp` and
 *     registers each tool. The token rides through the child env, never argv
 *     (same rule as codex.js).
 *
 * Contract (see stub.js): detect() and spawn(prompt, ctx) → { text, newSessionId }.
 */

import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdir, readdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  readUpstreamRefusal,
  spawnCredentials,
} from '../upstream-refusal.js';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { effectiveSandboxTrust } from '../environment.js';
import { GRANT_BROKER_REFUSAL, isGrantBrokerUrl } from './pi-mcp-client.mjs';
import { deliverSeatCredential, withholdRuntimeCredential } from '../mcp-credential-delivery.js';
import { removeCredentialFile, writeCredentialFile } from '../credential-file.js';

const DEFAULT_TIMEOUT_MS = (() => {
  const fallback = 15 * 60 * 1000;
  const raw = process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS;
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
})();

// The default provider is Commonly's own LiteLLM, reachable from a laptop
// seat at the public ingress and from a cluster seat at the service.
export const DEFAULT_PROVIDER = Object.freeze({
  name: 'litellm',
  baseUrl: 'https://litellm.commonly.me/v1',
  api: 'openai-completions',
  apiKeyEnv: 'COMMONLY_LITELLM_KEY',
});
export const DEFAULT_MODEL = 'deepseek-v4-flash';

// ADR-008 `effort` → pi `--thinking`. pi's ladder is off/minimal/low/medium/high/xhigh/max.
const THINKING = { none: 'off', off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
export const thinkingFor = (effort) => (effort ? THINKING[String(effort).toLowerCase()] || null : null);

const BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'pi-commonly-mcp.mjs');

// Same substitution contract as claude.js / codex.js: ${COMMONLY_*}
// placeholders in the declared MCP env are the wrapper's per-(agent, pod)
// runtime values, filled at spawn time.
const SUBSTITUTION_KEYS = ['COMMONLY_AGENT_TOKEN', 'COMMONLY_TOKEN_FILE', 'COMMONLY_API_URL', 'COMMONLY_INSTANCE_URL'];
const PLACEHOLDER_RE = /\$\{(COMMONLY_[A-Z_]+)\}/g;
const substitutePlaceholders = (value, ctx) => {
  if (typeof value !== 'string' || !value.includes('${COMMONLY_')) return value;
  const subs = {
    COMMONLY_AGENT_TOKEN: ctx.runtimeToken || '',
    // The PATH of this spawn's credential file. The bridge reads the file and
    // hands the VALUE to the server on fd 3, so the token still never reaches a
    // child's environment — but the payload that travels to the bridge carries a
    // path rather than the secret (TASK-083).
    COMMONLY_TOKEN_FILE: ctx.credentialFile || '',
    COMMONLY_API_URL: ctx.instanceUrl || '',
    COMMONLY_INSTANCE_URL: ctx.instanceUrl || '',
  };
  return value.replace(PLACEHOLDER_RE, (whole, key) => (SUBSTITUTION_KEYS.includes(key) && subs[key] ? subs[key] : whole));
};

/**
 * The daemon's own predicate, applied verbatim: `auditDeclaredMcp` reads
 * `server.transport || 'stdio'` and compares it as an exact string. It is
 * deliberately not friendlier than the guard's — a normalized `'HTTP'` or a
 * padded `' http '` is a shape the guard refuses as an unknown transport, and an
 * adapter that accepted one would be running something the guard never judged
 * (Vera, Connectors 69776). The schema admits `http`/`stdio`/`sse`
 * (environment.js:236) and admits an ABSENT transport, which the guard reads as
 * stdio; that is what this reads too.
 */
const transportOf = (server) => server.transport || 'stdio';

const originOf = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/**
 * Declared MCP servers from the environment spec, placeholders filled. Both
 * transports the spec admits are carried through: stdio (`command` + `env`) and
 * Streamable HTTP (`url` + `headers`). An entry with neither is skipped — there
 * is nothing to start.
 *
 * The HTTP half matters beyond a user-declared remote server: the grant broker
 * is a Streamable HTTP server (`agentBinding.ts` grantBrokerServer), so before
 * this pi dropped the one entry that carries a grant to a seat, silently.
 * Filling the headers here reuses the same substitution as the stdio env, and
 * the result is written into pi's fd 3 at spawn — a pipe the bridge reads to EOF
 * and closes (see takeServers), never the child's environment and never argv. The
 * environment is not usable for this: the kernel keeps the copy the process was
 * started with, so a same-user child could read the token back with
 * `ps eww $PPID` / `/proc/$PPID/environ` even after the bridge deleted its own
 * copy — which is what the previous channel did, and the row this closes
 * (Vera, Connectors).
 *
 * WHICH shape an entry becomes is decided by `transport` — the same field, read
 * with the same default and the same exact comparison the daemon's
 * `auditDeclaredMcp` judges it by — and the field that transport does not select
 * is dropped unsent. Classifying by which field is PRESENT instead is a bypass,
 * not a shorthand: an entry declaring `transport: 'http'` with the instance's own
 * url passes the guard (its http rule checks only the url origin, and
 * `${COMMONLY_AGENT_TOKEN}` in the command is one of the known placeholders), and
 * a presence-classifier then ran that command as stdio with the real token
 * substituted. The guard's judgement and the adapter's disagreed, and the adapter
 * is what executes (Vera, Connectors 69774).
 *
 * The http half also enforces the guard's own origin rule, so the HTTP half does
 * not depend on a guard that may not be on the machine: `auditDeclaredMcp`
 * admits a declared http server only when its url resolves to the INSTANCE's
 * origin, because the seat token rides its headers. Everything else — an
 * off-instance host, an unparseable url, an instance url we do not know — is
 * refused here as well. A transport pi cannot speak (`sse`, which the schema and
 * the guard both admit) is refused rather than reinterpreted as one it can.
 *
 * The grant broker is refused outright, by PATH rather than by entry name: it is
 * the one http entry that carries authority rather than data, and pi confines on
 * no host. wren's ruling for TASK-063 (`isGrantBrokerUrl` in pi-mcp-client.mjs),
 * the daemon-side half of the same refusal the server makes at the projection —
 * this is the half that holds on deploy skew, when the row names no adapter for
 * the server to key on, and in any backend older than the refusal.
 *
 * The stdio half does NOT have that property and must not be read as if it did:
 * a declared stdio command is executed with no allowlist check, here and in both
 * sibling adapters, so it depends entirely on the guard — `auditDeclaredMcp`
 * admits only the shipped commonly MCP server or a command already present in the
 * local record, and that rule exists nowhere else (Vera, 69778; TASK-069).
 */
export const resolveMcpServers = (mcpServers, ctx = {}) => {
  const carried = [];
  for (const server of mcpServers || []) {
    if (!server?.name || typeof server.name !== 'string') continue;
    const transport = transportOf(server);
    if (transport === 'http') {
      if (typeof server.url !== 'string' || !server.url) continue;
      const url = substitutePlaceholders(server.url, ctx);
      const origin = originOf(url);
      const instanceOrigin = originOf(ctx.instanceUrl);
      if (!origin || !instanceOrigin || origin !== instanceOrigin) {
        // eslint-disable-next-line no-console
        console.warn(`[pi] declared MCP server '${server.name}' points at ${origin || '(unparseable)'}, not this instance (${instanceOrigin || 'unknown'}) — not starting it`);
        continue;
      }
      // The grant broker is the one http entry that carries AUTHORITY rather
      // than data: a granted seat acts on external systems as the granter. A pi
      // seat cannot be confined on any host (see assertNoSandboxDeclared), so
      // the reach is refused here as well as at the server's projection — this
      // layer is what holds when the backend predates that refusal, when the
      // row names no adapter for the server to key on, or when a deploy leaves
      // the two on different clocks.
      if (isGrantBrokerUrl(url)) {
        // eslint-disable-next-line no-console
        console.warn(`[pi] ${GRANT_BROKER_REFUSAL} — refusing the grant broker '${server.name}': pi has no enforced sandbox, so this seat must not act with a granter's authority — move the seat to the claude or codex adapter, or remove the grant`);
        continue;
      }
      carried.push({
        name: server.name,
        url,
        headers: Object.fromEntries(Object.entries(server.headers || {}).map(([k, v]) => [k, substitutePlaceholders(v, ctx)])),
      });
      continue;
    }
    if (transport === 'stdio') {
      if (!Array.isArray(server.command) || !server.command.length) {
        // The url-only record that names no transport lands here: the guard reads
        // an absent transport as stdio too, and refuses it for having no command,
        // so the daemon never adopts it and this drop matches that judgement.
        if (typeof server.url === 'string' && server.url) {
          // eslint-disable-next-line no-console
          console.warn(`[pi] declared MCP server '${server.name}' names no transport, so it is judged stdio, and has no command — not starting it`);
        }
        continue;
      }
      carried.push({
        name: server.name,
        command: server.command.map((a) => substitutePlaceholders(a, ctx)),
        // Rewritten before substitution, so our own server is handed the file
        // (whose value the bridge pipes) instead of the token itself.
        env: Object.fromEntries(Object.entries(
          deliverSeatCredential(server, {
            credentialFile: ctx.credentialFile,
            label: 'pi',
          }).env,
        ).map(([k, v]) => [k, substitutePlaceholders(v, ctx)])),
      });
      continue;
    }
    // eslint-disable-next-line no-console
    console.warn(`[pi] declared MCP server '${server.name}' asks for transport '${transport}', which this adapter cannot speak — not starting it`);
  }
  return carried;
};

/** The provider block for models.json: the env spec's `provider` over the LiteLLM default. */
export const resolveProvider = (environment = {}) => {
  const spec = environment?.provider || {};
  return {
    name: spec.name || DEFAULT_PROVIDER.name,
    baseUrl: spec.baseUrl || DEFAULT_PROVIDER.baseUrl,
    api: spec.api || DEFAULT_PROVIDER.api,
    apiKeyEnv: spec.apiKeyEnv || DEFAULT_PROVIDER.apiKeyEnv,
  };
};

/** models.json content for one seat: one provider, one model, key by env reference. */
export const buildModelsJson = (provider, model) => ({
  providers: {
    [provider.name]: {
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: `$${provider.apiKeyEnv}`,
      api: provider.api,
      models: [{
        id: model,
        name: model,
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32000,
      }],
    },
  },
});

/** Per-seat pi home: `~/.commonly/pi-homes/<hash(agent)>`. Never the operator's ~/.pi. */
export const seatHome = (ctx) => {
  const identity = ctx.agentName || ctx.cwd || 'anonymous';
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return ctx._piHome || join(homedir(), '.commonly', 'pi-homes', hash);
};

/**
 * Only a session pi wrote can be resumed. The wrapper persists one id per
 * (agent, pod) across adapters, so a seat switched from codex hands pi the
 * codex thread id on its first turn — pi answers `No session found` and the
 * turn fails (sprint-impl's first spawn, 2026-09-18 05:06Z). pi's session
 * files are `<timestamp>_<id>.jsonl` under the seat's session dir; an id with
 * no file starts a fresh session under a new id, which the wrapper persists.
 */
export const sessionExists = async (sessionDir, sessionId) => {
  if (!sessionId) return false;
  try {
    const files = await readdir(sessionDir);
    return files.some((name) => name.endsWith(`_${sessionId}.jsonl`) || name === `${sessionId}.jsonl`);
  } catch {
    return false;
  }
};

/**
 * Fail closed: pi cannot enforce `environment.sandbox`, so a seat that declares
 * one does not start.
 *
 * The trust is read THROUGH the legacy table (`effectiveSandboxTrust`), not
 * raw. A stored `internal` means `public` (Vera 69592, Wren 69585) and every
 * other gate in this package resolves it that way: the attach path
 * (`agent.js`), the mode resolver (`sandbox/mode.js`) and the grant-broker
 * guard. Reading it raw here made this gate the one site that failed OPEN — a
 * legacy record passed both checks and the seat started unconfined, which is
 * the exact outcome that was refused for the record it was migrated from.
 * The mode clause needs no mapping: `internal` and the derived mode are
 * independent, and a public-meaning record is refused before the mode is read.
 */
export const assertNoSandboxDeclared = (environment = {}) => {
  const sandbox = environment?.sandbox || {};
  if (effectiveSandboxTrust(sandbox.trust) === 'public') {
    throw new Error('pi adapter: public-trust seats are not supported — pi has no enforced sandbox; do not attach a pi seat to a stranger-readable pod');
  }
  if (sandbox.mode && sandbox.mode !== 'none') {
    throw new Error(`pi adapter: sandbox.mode=${sandbox.mode} cannot be enforced by pi; remove it or use the claude/codex adapter`);
  }
};

export const buildArgs = ({
  prompt, provider, model, thinking, sessionId, isResume, sessionDir, bridge,
}) => [
  '-p',
  '--mode', 'json',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--provider', provider,
  '--model', model,
  ...(thinking ? ['--thinking', thinking] : []),
  '--session-dir', sessionDir,
  ...(isResume ? ['--session', sessionId] : ['--session-id', sessionId]),
  ...(bridge ? ['-e', bridge] : []),
  prompt,
];

/** The reply is the last assistant `message_end`'s text parts; tool calls are not text. */
export const extractReply = (stdout) => {
  let text = '';
  let sawAssistant = false;
  const errors = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'message_end' && event.message?.role === 'assistant') {
      const parts = (event.message.content || []).filter((c) => c?.type === 'text').map((c) => c.text || '');
      if (parts.length) { text = parts.join('\n').trim(); sawAssistant = true; }
    }
    if (event?.type === 'error') errors.push(String(event.message || event.error || 'error'));
  }
  return { text, sawAssistant, errors };
};

const runPi = ({ args, cwd, env, payload, timeoutMs, credentials = [], spawnImpl = childSpawn }) => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  // fd 3 carries the MCP server list, so the 4th pipe exists exactly when there
  // is a list to hand over. The bridge reads it at extension load (takeServers).
  const withList = typeof payload === 'string';
  const proc = spawnImpl('pi', args, { cwd, env, stdio: withList ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
  if (withList) {
    const channel = proc.stdio && proc.stdio[3];
    // A missing pipe is an invariant break, not a degraded mode: the bridge would
    // read EBADF and the seat would silently have no commonly_* tools.
    if (!channel) { reject(new Error('pi adapter: no fd 3 pipe to carry the MCP server list')); return; }
    // The child may exit before draining; that surfaces on 'close', so a write
    // error here must not become an unhandled error event.
    channel.on('error', () => {});
    channel.end(payload);
  }
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, timeoutMs);
  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (timedOut) return reject(new Error(`pi timed out after ${timeoutMs}ms`));
    const reply = extractReply(stdout);
    // A refused model route is NOT an error event: pi retries the ladder itself
    // and exits 0 with no assistant text, which is why this read has to happen
    // on the stream rather than on the exit code (TASK-096, measured 2026-09-22).
    const upstream = readUpstreamRefusal(stdout, { credentials });
    if (upstream) reply.upstream = upstream;
    if (code !== 0 && !reply.sawAssistant) {
      const tail = (reply.errors.join(' | ') || stderr).trim().slice(-600);
      return reject(new Error(`pi exited ${code}: ${tail}`));
    }
    return resolve(reply);
  });
});

export default {
  name: 'pi',

  // TASK-049: the variable this adapter needs from the environment of whatever
  // process spawns it. Declared HERE because the adapter owns the provider; the
  // registry collects it (adapters/index.js) so the daemon can carry the key
  // into its login service and fail loudly at bind when it is absent, instead
  // of the seat dying at line ~406 with nothing naming the missing variable at
  // daemon level.
  providerKeyEnv: DEFAULT_PROVIDER.apiKeyEnv,

  async detect() {
    const res = spawnSync('pi', ['--version'], { encoding: 'utf8' });
    if (res.error || res.status !== 0) return null;
    const version = String(res.stdout || '').trim().split('\n').pop() || 'unknown';
    const which = spawnSync('which', ['pi'], { encoding: 'utf8' });
    return { path: String(which.stdout || 'pi').trim() || 'pi', version };
  },

  async spawn(prompt, ctx = {}) {
    // pi has no enforced sandbox. claude.js and codex.js refuse a public-trust
    // seat they cannot confine; so does this adapter, and it refuses any declared
    // sandbox mode rather than run unconfined under a spec that promised one.
    assertNoSandboxDeclared(ctx.environment);
    const provider = resolveProvider(ctx.environment);
    const model = ctx.environment?.model || DEFAULT_MODEL;
    const thinking = thinkingFor(ctx.environment?.effort);
    const baseEnv = ctx.env || process.env;
    if (!baseEnv[provider.apiKeyEnv]) {
      throw new Error(`pi adapter: ${provider.apiKeyEnv} is not set — the seat's environment must carry the provider key (LiteLLM virtual key)`);
    }
    // The values this spawn is handed, for the refusal log's exact-match check:
    // the provider key the route authenticates with, and the seat credential the
    // bridge carries. Snapshot them HERE — `withholdRuntimeCredential` removes
    // the token from the child copy below, and after that there is nothing left
    // to compare a refusal against.
    const credentials = spawnCredentials(ctx, [provider.apiKeyEnv]);

    // Per-seat pi home: models.json holds the provider by env reference.
    const home = seatHome(ctx);
    const agentDir = join(home, 'agent');
    const sessionDir = join(home, 'sessions');
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });

    // Resume only what pi wrote; anything else (a codex thread id from before
    // the switch, a wiped home) starts fresh under a new id.
    const isResume = await sessionExists(sessionDir, ctx.sessionId);
    const sessionId = isResume ? ctx.sessionId : randomUUID();
    const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, { freshSession: !isResume });
    await writeFile(join(agentDir, 'models.json'), `${JSON.stringify(buildModelsJson(provider, model), null, 2)}\n`, { mode: 0o600 });

    // One credential file per spawn, inside this seat's own 0700 home — pi has no
    // enforced sandbox, so the seat's home is the narrowest place that is still
    // readable by the bridge. The value the server receives still travels on fd 3
    // (pi-mcp-client's fd channel); the file is where the launcher puts it.
    const credential = writeCredentialFile(ctx.runtimeToken, {
      agentName: ctx.agentName || 'agent',
      root: join(home, 'credentials'),
    });
    try {
      const servers = resolveMcpServers(ctx.environment?.mcp, {
        ...ctx,
        credentialFile: credential?.path || null,
      });
      const childEnv = {
        ...baseEnv,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SKIP_VERSION_CHECK: '1',
      };
      // `baseEnv` is normally the process environment, which carries the
      // bootstrap export. Nothing below this process needs the value: the bridge
      // is handed the servers, their resolved values included, over fd 3. It has
      // to come out rather than merely stop being added, because pi's `bash`
      // tool spawns children with `{ ...process.env }`, so a copy here is a copy
      // in the seat's shell — and the file path goes in, so a hook resolves its
      // credential without the value.
      withholdRuntimeCredential(childEnv, {
        credentialFile: credential?.path || null,
      });
      const args = buildArgs({
        prompt: fullPrompt, provider: provider.name, model, thinking, sessionId, isResume, sessionDir,
        bridge: servers.length ? (ctx._bridgePath || BRIDGE_PATH) : null,
      });

      const reply = await runPi({
        args,
        cwd: ctx.cwd,
        env: childEnv,
        payload: servers.length ? JSON.stringify(servers) : undefined,
        timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
        credentials,
        spawnImpl: ctx._spawnImpl, // test seam only — do not use in production
      });
      // Empty text with a clean exit is a silent turn; the run loop treats it
      // as NO_REPLY-shaped and re-delivers on its own rules. Empty text that
      // came with a refusal is named instead — see upstream-refusal.js.
      return { text: reply.text, newSessionId: sessionId, upstream: reply.upstream ?? null };
    } finally {
      // Best effort: the bridge has already read what it needs by the time the
      // turn ends, and a token file that outlives its turn is a token file that
      // sits in a home for the next one.
      removeCredentialFile(credential);
    }
  },
};
