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
 *     env reference (`$COMMONLY_LITELLM_KEY`, or `$COMMONLY_PI_PROVIDER_KEY`
 *     for a seat with its own provider.keyFile), so it never lands on disk.
 *   - Commonly's tools reach pi through pi-commonly-mcp.mjs, an extension
 *     that speaks MCP over stdio to every server in `environment.mcp` and
 *     registers each tool. The token rides through the child env, never argv
 *     (same rule as codex.js).
 *
 * A public seat (F113b) runs the same pi as
 *   sandbox-exec -p <profile> <abs pi> … --no-builtin-tools
 *      --exclude-tools <pi built-ins + PUBLIC_SEAT_WITHHELD_TOOLS> --no-approve …
 * with a scrubbed environment and the provider behind a loopback proxy. pi's
 * MCP servers start inside the jailed pi (the bridge is in-process), so they
 * inherit the profile. Confinement is an explicit `sandbox.trust: 'public'`,
 * never a derived default: a derived one would strip the shell from every
 * private fleet pi seat (default-environment.js).
 *
 * Contract (see stub.js): detect() and spawn(prompt, ctx) → { text, newSessionId }.
 */

import { requireSeatModel } from './seat-model.js';
import { probeVersion } from './tested-version.js';
import { resolveOnPath } from '../resolve-on-path.js';
import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'fs';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import {
  dirname, isAbsolute, join, relative, sep,
} from 'path';
import { fileURLToPath } from 'url';
import {
  adapterFailure,
  readUpstreamRefusal,
  spawnCredentials,
} from '../upstream-refusal.js';
import { buildMemoryPreamble } from '../memory-bridge.js';
import {
  effectiveSandboxTrust, normalizeSandboxTrust, refuseWorkspaceTrust, validateEnvironmentSpec,
} from '../environment.js';
import { GRANT_BROKER_PUBLIC_ONLY_REFUSAL, isGrantBrokerUrl } from './pi-mcp-client.mjs';
import { deliverSeatCredential, withholdRuntimeCredential } from '../mcp-credential-delivery.js';
import { prepareMcpSpawn, publicMcpUnavailableError, selectedMcpVersionDir } from '../mcp-home.js';
import { removeCredentialFile, writeCredentialFile } from '../credential-file.js';
import { resolvePublicSandboxMode } from '../sandbox/mode.js';
import { wrapArgvWithSeatbelt } from '../sandbox/seatbelt.js';
import { resolveProviderKeyFile, startProviderProxy } from '../provider-proxy.js';
import { PUBLIC_SEAT_WITHHELD_TOOLS } from '../public-withheld-tools.js';

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

// What a seat with its own `provider.keyFile` calls its key inside pi. A private
// turn holds the key here, and pi-shell-env.mjs keeps it out of pi's shells. A
// public turn holds the proxy's token here. models.json holds only `$` + this.
const OWN_KEY_ENV = 'COMMONLY_PI_PROVIDER_KEY';

// The shared provider shape's `api` (environment.js PROVIDER_APIS) in pi's own
// words. Both measured on pi 0.84.1 against a local stub: `openai-completions`
// calls `<baseURL>/chat/completions` with a Bearer, `anthropic-messages` calls
// `<baseURL>/v1/messages` with x-api-key, so an Anthropic baseURL is the host,
// as it is for OpenCode and for the provider proxy.
const PI_PROVIDER_APIS = Object.freeze({
  'openai-chat': 'openai-completions',
  'anthropic-messages': 'anthropic-messages',
});

// ADR-008 `effort` → pi `--thinking`. pi's ladder is off/minimal/low/medium/high/xhigh/max.
const THINKING = { none: 'off', off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
export const thinkingFor = (effort) => (effort ? THINKING[String(effort).toLowerCase()] || null : null);

const ADAPTERS_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = join(ADAPTERS_DIR, 'pi-commonly-mcp.mjs');
const SHELL_ENV_PATH = join(ADAPTERS_DIR, 'pi-shell-env.mjs');
// The bridge imports siblings from the CLI's lib dir (credential-file.js,
// mcp-server-version.js), so a jailed pi must be able to read that tree. It
// holds code only.
const EXTENSION_CODE_ROOT = dirname(ADAPTERS_DIR);

// A public seat runs only a pi version whose tool flags were checked against a
// real headless turn under Seatbelt: `--no-builtin-tools`, `--exclude-tools`
// (which removes a tool from pi's registry, extension tools included, not only
// from the active set) and `--no-approve`. Add a version only with that smoke.
export const TESTED_PI_VERSIONS = Object.freeze(['0.84.1']);
const PI_PACKAGE = '@earendil-works/pi-coding-agent';

// pi's built-in tools (`allToolNames`, core/tools/index.js in 0.84). A public
// seat gets none of them: no shell, and no file reads either, because the jail
// has to admit the seat home that holds this turn's credential file (the bridge
// reads it), so a read tool could hand that file to the room. Every public
// adapter denies its shell; Qwen denies its read tools for this same reason,
// and Goose loads no built-in at all.
export const PI_BUILTIN_TOOLS = Object.freeze(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
export const PUBLIC_EXCLUDED_TOOLS = Object.freeze([...PI_BUILTIN_TOOLS, ...PUBLIC_SEAT_WITHHELD_TOOLS]);

// What a public pi inherits from the launcher's environment. Everything else
// (operator variables, the real provider key, the seat token) stays out.
const PUBLIC_SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;
const safeEnv = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => PUBLIC_SAFE_ENV.test(name)));

// The one provider API the loopback proxy carries for pi. The proxy's model pin
// checks chat completions only, and a public turn must not run unpinned.
const PUBLIC_PROVIDER_API = 'openai-completions';
const publicApiRefusal = (api) => `pi adapter: a public seat reaches its provider through a loopback proxy that carries the ${PUBLIC_PROVIDER_API} API only, not ${api}`;

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
 * The schema admits `http`/`stdio`/`sse`
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
 * copy — which is what the previous channel did, and the row this closes.
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
 * is what executes.
 *
 * The http half also enforces the guard's own origin rule, so the HTTP half does
 * not depend on a guard that may not be on the machine: `auditDeclaredMcp`
 * admits a declared http server only when its url resolves to the INSTANCE's
 * origin, because the seat token rides its headers. Everything else — an
 * off-instance host, an unparseable url, an instance url we do not know — is
 * refused here as well. A transport pi cannot speak (`sse`, which the schema and
 * the guard both admit) is refused rather than reinterpreted as one it can.
 *
 * The grant broker is carried only on a public turn (F175c), keyed by PATH
 * rather than entry name (`isGrantBrokerUrl` in pi-mcp-client.mjs). It is the
 * one http entry that carries authority rather than data, and a public turn is
 * the only pi turn that is confined: Seatbelt on macOS (`assertSandboxSupported`
 * refuses a public turn anywhere else before this runs), with no built-in tool,
 * so the model cannot open a file at all. A carried broker is marked
 * `confined: true` for the bridge's own filter, and its name is reported on
 * `ctx.grantBrokers` so the spawn can end the credential file's life early. It
 * also names `ctx.credentialDir`, as a path, for the bridge to delete from
 * inside pi (`removeSpawnCredential`).
 * Every other pi turn refuses it, a broker the server flagged as named (F94)
 * included: this is the daemon-side half of the server's
 * `adapter_confines_public_only`, and the half that holds on deploy skew.
 *
 * The stdio half does NOT have that property and must not be read as if it did:
 * a declared stdio command is executed with no allowlist check, here and in both
 * sibling adapters, so it depends entirely on the guard — `auditDeclaredMcp`
 * admits only the shipped commonly MCP server or a command already present in the
 * local record, and that rule exists nowhere else (TASK-069).
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
      // The grant broker carries AUTHORITY rather than data: a granted seat acts
      // on external systems as the granter. Only a confined (public) pi turn
      // may hold it; see the header above.
      const grantBroker = isGrantBrokerUrl(url);
      if (grantBroker && !ctx.publicSeat) {
        // eslint-disable-next-line no-console
        console.warn(`[pi] ${GRANT_BROKER_PUBLIC_ONLY_REFUSAL} — refusing the grant broker '${server.name}': pi carries a granter's authority only on a public seat confined by the macOS sandbox, and this seat is not one — declare sandbox.trust 'public' on a Mac, or remove the grant`);
        continue;
      }
      if (grantBroker) ctx.grantBrokers?.push(server.name);
      carried.push({
        name: server.name,
        url,
        headers: Object.fromEntries(Object.entries(server.headers || {}).map(([k, v]) => [k, substitutePlaceholders(v, ctx)])),
        ...(ctx.publicSeat ? { withheldTools: [...PUBLIC_SEAT_WITHHELD_TOOLS] } : {}),
        ...(grantBroker ? { confined: true } : {}),
        ...(grantBroker && ctx.credentialDir ? { credentialDir: ctx.credentialDir } : {}),
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
      // TASK-174: what will EXECUTE — the warmed build from the seat's MCP home
      // when there is one — and the credential channel is decided on that same
      // command, so the two can never disagree about which release runs.
      const spawnCommand = prepareMcpSpawn(server.command, { apiUrl: ctx.instanceUrl, publicSeat: Boolean(ctx.publicSeat) });
      // A public seat never runs a package runner (npx) from inside the jail; the
      // host-prepared build is the only stdio Commonly server it may start, and
      // that build's tree has to be readable inside the profile.
      if (!spawnCommand) {
        ctx.unavailableMcp?.push(server.name);
        continue;
      }
      if (ctx.publicSeat) {
        const versionDir = selectedMcpVersionDir(spawnCommand);
        if (versionDir) ctx.mcpReadDirectories?.push(versionDir);
      }
      carried.push({
        name: server.name,
        command: spawnCommand.map((a) => substitutePlaceholders(a, ctx)),
        // Rewritten before substitution, so our own server is handed the file
        // (whose value the bridge pipes) instead of the token itself.
        env: Object.fromEntries(Object.entries(
          deliverSeatCredential({ ...server, command: spawnCommand }, {
            credentialFile: ctx.credentialFile,
            label: 'pi',
          }).env,
        ).map(([k, v]) => [k, substitutePlaceholders(v, ctx)])),
        ...(ctx.publicSeat ? { withheldTools: [...PUBLIC_SEAT_WITHHELD_TOOLS] } : {}),
      });
      continue;
    }
    // eslint-disable-next-line no-console
    console.warn(`[pi] declared MCP server '${server.name}' asks for transport '${transport}', which this adapter cannot speak — not starting it`);
  }
  return carried;
};

/**
 * Two provider shapes reach this adapter. The shared one, `{ id, baseURL,
 * keyFile, models, api }`, is what `--env` accepts and validateEnvironmentSpec
 * checks. pi's own, `{ name, baseUrl, api, apiKeyEnv }`, is a token-file
 * override older than that validation, and its `api` is pi's word for it. A key
 * only the shared shape has decides; a block with keys from both is then judged
 * as shared, and validation refuses it rather than reading half of each.
 */
const SHARED_PROVIDER_KEYS = ['id', 'baseURL', 'keyFile', 'models'];
const isSharedProvider = (spec) => Boolean(spec) && SHARED_PROVIDER_KEYS.some((key) => spec[key] !== undefined);

/** The real key file of a shared provider, validated without reading it; null for any other seat. */
const sharedProviderKeyFile = async (environment, workspacePath) => {
  if (!isSharedProvider(environment?.provider)) return null;
  const validation = validateEnvironmentSpec(environment);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return resolveProviderKeyFile(environment.provider, workspacePath, 'pi');
};

/**
 * The proxy reads a public seat's key file from this process, so the file stays
 * out of the jail, and nothing here admits it. The jail does admit these
 * directories, and the seat home is a stable path a key file could be put in,
 * so a key under one of them would be readable from inside.
 */
const refuseKeyFileInJail = (keyFile, readableDirectories) => {
  for (const directory of readableDirectories) {
    const fromDirectory = relative(realpathSync(directory), keyFile);
    if (fromDirectory !== '..' && !fromDirectory.startsWith(`..${sep}`) && !isAbsolute(fromDirectory)) {
      throw new Error(`pi adapter: provider.keyFile ${keyFile} is inside the sandbox of a public seat; move it outside ${directory}`);
    }
  }
};

/** The private turn's key, read the way goose reads it, refused if empty. */
const readOwnKey = async (keyFile) => {
  const key = (await readFile(keyFile, 'utf8')).trim();
  if (!key) throw new Error('pi adapter: provider.keyFile must not be empty');
  return key;
};

/** The provider block for models.json: the env spec's `provider` over the LiteLLM default. */
export const resolveProvider = (environment = {}) => {
  const spec = environment?.provider || {};
  if (isSharedProvider(spec)) {
    return {
      name: spec.id,
      baseUrl: spec.baseURL,
      api: PI_PROVIDER_APIS[spec.api || 'openai-chat'],
      apiKeyEnv: OWN_KEY_ENV,
      reasoning: spec.models?.[environment.model]?.reasoning !== false,
    };
  }
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
        reasoning: provider.reasoning ?? true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32000,
      }],
    },
  },
});

/**
 * Per-seat pi home: `~/.commonly/pi-homes/<hash(agent)>`. Never the operator's ~/.pi.
 *
 * A public turn gets its own sibling, `<hash>-public`. The home holds the
 * seat's sessions, so a shared one let a seat switched from private to public
 * resume a session full of private history: the wrapper hands back the id it
 * persisted, and `sessionExists` found it. In a separate home that id is not
 * found and the public turn starts fresh; and the Seatbelt profile admits only
 * the public home, so the private one is not readable from inside either.
 */
export const seatHome = (ctx, { publicSeat = false } = {}) => {
  const identity = ctx.agentName || ctx.cwd || 'anonymous';
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  const base = ctx._piHome || join(homedir(), '.commonly', 'pi-homes', hash);
  return publicSeat ? `${base}-public` : base;
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
 * What pi can enforce: a public seat, confined by Seatbelt on macOS (F113b),
 * and nothing else.
 *
 * The trust is read THROUGH the legacy table (`effectiveSandboxTrust`), not
 * raw. A stored `internal` means `public` and every other gate in this package
 * resolves it that way: the attach path (`agent.js`), the mode resolver
 * (`sandbox/mode.js`) and the grant-broker guard. Reading it raw here once made
 * this gate the one site that failed OPEN (TASK-114).
 *
 * Seatbelt only. pi has no bwrap path yet, so a public seat off macOS, or one
 * that names `bwrap`, is refused rather than run unconfined. A non-public seat
 * that declares a mode is refused too: nothing would enforce it.
 */
export const assertSandboxSupported = (environment = {}, platform = process.platform) => {
  const sandbox = environment?.sandbox || {};
  refuseWorkspaceTrust(sandbox, 'pi');
  if (effectiveSandboxTrust(sandbox.trust) === 'public') {
    const mode = resolvePublicSandboxMode(sandbox, platform);
    if (!['workspace', 'read-only', 'bwrap'].includes(mode)) {
      throw new Error('pi adapter: public seats require an enforced sandbox');
    }
    if (platform !== 'darwin' || mode === 'bwrap') {
      throw new Error('pi adapter: public seats run only in the macOS Seatbelt sandbox; pi has no bwrap path yet, so this seat cannot run confined here');
    }
    if (sandbox.filesystem?.['read-outside']?.length) {
      throw new Error('pi adapter: public seats do not allow sandbox.filesystem.read-outside');
    }
    if (sandbox.network?.policy === 'restricted') {
      throw new Error('pi adapter: public seats do not support restricted networking');
    }
    return;
  }
  if (sandbox.mode && sandbox.mode !== 'none') {
    throw new Error(`pi adapter: sandbox.mode=${sandbox.mode} cannot be enforced by pi without public trust; declare sandbox.trust 'public' or remove the mode`);
  }
};

// Shared with the version probe (tested-version.js).
export { resolveOnPath };

/**
 * pi's install tree: the nearest directory above the real entry file whose
 * package.json names pi. Its `node_modules` and dist are what a jailed pi loads,
 * and nothing else under that prefix needs to be readable.
 */
export const piPackageRoot = (binary) => {
  let dir;
  try { dir = dirname(realpathSync(binary)); } catch { return null; }
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === PI_PACKAGE) return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const versionOf = (value) => String(value || '').trim().match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;

export const buildArgs = ({
  prompt, provider, model, thinking, sessionId, isResume, sessionDir, bridge, publicSeat = false,
}) => [
  '-p',
  '--mode', 'json',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  // A public seat: no built-in tool (no shell, no file access), the withheld
  // Commonly tools removed from the registry, and no project-local pi files
  // from the workspace trusted for this run.
  ...(publicSeat ? ['--no-builtin-tools', '--exclude-tools', PUBLIC_EXCLUDED_TOOLS.join(','), '--no-approve'] : []),
  '--provider', provider,
  '--model', model,
  ...(thinking ? ['--thinking', thinking] : []),
  '--session-dir', sessionDir,
  ...(isResume ? ['--session', sessionId] : ['--session-id', sessionId]),
  ...(bridge ? ['-e', bridge] : []),
  prompt,
];

/**
 * The reply is the last assistant `message_end`'s text parts; tool calls are not
 * text. `finished` means pi ended the turn on an answer: `agent_end`, not retried,
 * after an assistant message that stopped with `stop`. An overflow's `agent_end`
 * says `willRetry: false` and then pi compacts and continues, so `agent_end` after
 * an `error` or `length` stop doesn't count; the continuation's message decides.
 */
export const extractReply = (stdout) => {
  let text = '';
  let sawAssistant = false;
  let finished = false;
  let lastStop = null;
  const errors = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'message_end' && event.message?.role === 'assistant') {
      const parts = (event.message.content || []).filter((c) => c?.type === 'text').map((c) => c.text || '');
      if (parts.length) { text = parts.join('\n').trim(); sawAssistant = true; }
      lastStop = event.message.stopReason;
      finished = false;
    }
    if (event?.type === 'agent_end') finished = event.willRetry !== true && lastStop === 'stop';
    if (event?.type === 'error') errors.push(String(event.message || event.error || 'error'));
  }
  return { text, sawAssistant, finished, errors };
};

// A turn that printed an interim message and then ended without finishing. A
// crash keeps its cause, so a quota line in stderr or a refusal on the stream
// still classifies. A signal (143, 129, or a null code) has neither: stderr then
// holds pi's startup warnings, and a refusal on the stream may be one pi was
// recovering from, like an overflow's 400.
const stoppedTurnFailure = (reply, {
  code, signal, stderr, credentials,
}) => {
  const killed = Boolean(signal) || code === 143 || code === 129;
  const upstream = killed ? null : reply.upstream;
  const failure = adapterFailure(
    'pi',
    reply.errors.join(' | ') || (killed ? '' : stderr.trim().slice(-600)) || upstream?.detail
      || 'the turn stopped before it finished',
    { credentials, exitCode: code, limit: 600 },
  );
  if (upstream) failure.status ??= upstream.status;
  return failure;
};

/**
 * The first whole NDJSON line pi prints, as a callback. In json mode pi writes
 * its session header before it binds the session and sends the prompt, and only
 * after every extension factory has returned (main.js builds the runtime, which
 * loads and awaits each `-e` extension, then print-mode.js writes the header;
 * pi 0.84.1). So the bridge has read the server list and every credential it
 * needed by the time this fires, and the model has not been called yet. Any
 * line that parses with a string `type` counts: a resumed session's header and
 * `agent_start` both come after the extensions too.
 */
const firstEventWatcher = (onFirstEvent) => {
  let buffer = '';
  let fired = !onFirstEvent;
  return (chunk) => {
    if (fired) return;
    buffer += chunk;
    let nl;
    while (!fired && (nl = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let event;
      try { event = JSON.parse(raw); } catch { continue; }
      if (event && typeof event.type === 'string') {
        fired = true;
        buffer = '';
        onFirstEvent();
      }
    }
  };
};

const runPi = ({
  command = 'pi', args, cwd, env, payload, timeoutMs, credentials = [], spawnImpl = childSpawn, onFirstEvent,
}) => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let hookError = null;
  // fd 3 carries the MCP server list, so the 4th pipe exists exactly when there
  // is a list to hand over. The bridge reads it at extension load (takeServers).
  const withList = typeof payload === 'string';
  const proc = spawnImpl(command, args, { cwd, env, stdio: withList ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
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
  const watch = firstEventWatcher(onFirstEvent);
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    // Synchronous, in the tick the line is parsed. A hook that throws ends the
    // turn: pi is killed and the error is the turn's result.
    try {
      watch(text);
    } catch (err) {
      if (!hookError) {
        hookError = err;
        proc.kill('SIGKILL');
      }
    }
  });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  proc.on('close', (code, signal) => {
    clearTimeout(timer);
    if (hookError) return reject(hookError);
    if (timedOut) return reject(new Error(`pi timed out after ${timeoutMs}ms`));
    const reply = extractReply(stdout);
    // A refused model route is NOT an error event: pi retries the ladder itself
    // and exits 0 with no assistant text, which is why this read has to happen
    // on the stream rather than on the exit code (TASK-096, measured 2026-09-22).
    const upstream = readUpstreamRefusal(stdout, { credentials });
    if (upstream) reply.upstream = upstream;
    // Without `finished`, the text pi printed was an interim message, so posting
    // it would answer with half a turn and acknowledge what it held. An error
    // event fails the turn even after `finished`, which could otherwise read as
    // silent. A tool-only turn that finished stays silent, whatever the exit.
    if (code !== 0 && (!reply.finished || reply.errors.length)) {
      if (reply.sawAssistant) {
        return reject(stoppedTurnFailure(reply, {
          code, signal, stderr, credentials,
        }));
      }
      const tail = (reply.errors.join(' | ') || stderr).trim().slice(-600);
      return reject(new Error(`pi exited ${code}: ${tail}`));
    }
    return resolve(reply);
  });
});

export default {
  requiresModel: true,
  name: 'pi',

  // TASK-049: the variable this adapter needs from the environment of whatever
  // process spawns it. Declared HERE because the adapter owns the provider; the
  // registry collects it (adapters/index.js) so the daemon can carry the key
  // into its login service and fail loudly at bind when it is absent, instead
  // of the seat dying at line ~406 with nothing naming the missing variable at
  // daemon level.
  // A seat with its own provider.keyFile doesn't need it; spawn doesn't ask.
  providerKeyEnv: DEFAULT_PROVIDER.apiKeyEnv,

  supportsProvider: true,
  providerApis: Object.keys(PI_PROVIDER_APIS),

  // The rule pi adds to the shared provider check. Its own shape names pi's
  // api, which the shared list doesn't hold. A public seat can't take a wire
  // the proxy doesn't pin. Anything else goes to the shared check (undefined).
  providerVerdict(environment) {
    const spec = environment?.provider;
    if (!isSharedProvider(spec)) return null;
    if (effectiveSandboxTrust(environment?.sandbox?.trust) !== 'public') return undefined;
    const api = PI_PROVIDER_APIS[spec.api || 'openai-chat'];
    return api && api !== PUBLIC_PROVIDER_API ? publicApiRefusal(api) : undefined;
  },

  // Attach runs this before anything is published, so a public pi seat this
  // host cannot confine is refused there rather than at its first turn, and so
  // is a provider block or key file that couldn't be used.
  async validateEnvironment(environment, workspacePath) {
    assertSandboxSupported(environment);
    return sharedProviderKeyFile(environment, workspacePath);
  },

  async detect() {
    const res = spawnSync('pi', ['--version'], { encoding: 'utf8' });
    if (res.error || res.status !== 0) return null;
    const version = String(res.stdout || '').trim().split('\n').pop() || 'unknown';
    const which = spawnSync('which', ['pi'], { encoding: 'utf8' });
    return { path: String(which.stdout || 'pi').trim() || 'pi', version };
  },

  async spawn(prompt, ctx = {}) {
    const seatModel = requireSeatModel(ctx.environment, 'pi', true);
    const platform = ctx._platform || process.platform;
    // A public seat is confined by Seatbelt below; every sandbox declaration pi
    // cannot honour on this host is refused here, before anything starts.
    assertSandboxSupported(ctx.environment, platform);
    const sandbox = normalizeSandboxTrust(ctx.environment?.sandbox);
    const isPublic = effectiveSandboxTrust(sandbox?.trust) === 'public';
    const keyFile = await sharedProviderKeyFile(ctx.environment, ctx.cwd);
    const provider = resolveProvider(ctx.environment);
    const model = seatModel;
    const thinking = thinkingFor(ctx.environment?.effort);
    const baseEnv = ctx.env || process.env;
    // A public turn leaves the key file to the proxy, so this process holds the
    // value only for a private pi, which is the one that is handed it.
    const ownKey = keyFile && !isPublic ? await readOwnKey(keyFile) : null;
    if (!keyFile && !baseEnv[provider.apiKeyEnv]) {
      throw new Error(`pi adapter: ${provider.apiKeyEnv} is not set — the seat's environment must carry the provider key (LiteLLM virtual key)`);
    }

    // What a public turn runs inside the jail: the absolute pi entry, the
    // package tree it loads, and the node its shebang resolves to.
    let binary = 'pi';
    let packageRoot = null;
    let nodePath = null;
    if (isPublic) {
      if (provider.api !== PUBLIC_PROVIDER_API) {
        throw new Error(publicApiRefusal(provider.api));
      }
      if (!ctx.cwd || !isAbsolute(ctx.cwd)) {
        throw new Error('pi adapter: a public seat needs an absolute workspace path');
      }
      binary = ctx._binaryPath || resolveOnPath('pi', baseEnv.PATH);
      if (!binary || !isAbsolute(binary)) {
        throw new Error('pi adapter: a public seat needs an absolute pi executable on PATH');
      }
      packageRoot = piPackageRoot(binary);
      if (!packageRoot) {
        throw new Error(`pi adapter: no ${PI_PACKAGE} package found behind ${binary}, so the sandbox cannot admit pi's code`);
      }
      // Async and cached per binary (tested-version.js): a synchronous probe
      // stalled every other seat's proxy on the daemon's loop.
      const version = ctx._version || await probeVersion(binary, {
        env: safeEnv(baseEnv), timeoutMs: 30000, parse: versionOf,
      });
      if (!TESTED_PI_VERSIONS.includes(version)) {
        throw new Error(`pi adapter: public seats refuse untested pi version ${version || 'unknown'}; smoke-tested: ${TESTED_PI_VERSIONS.join(', ')}`);
      }
      nodePath = resolveOnPath('node', baseEnv.PATH);
    }

    // The values this spawn is handed, for the refusal log's exact-match check:
    // the provider key the route authenticates with, and the seat credential the
    // bridge carries. Snapshot them HERE — `withholdRuntimeCredential` removes
    // the token from the child copy below, and after that there is nothing left
    // to compare a refusal against.
    const credentials = spawnCredentials(ctx, [provider.apiKeyEnv]);
    if (ownKey) credentials.push(ownKey);

    // Per-seat pi home: models.json holds the provider by env reference.
    const home = seatHome(ctx, { publicSeat: isPublic });
    const agentDir = join(home, 'agent');
    const sessionDir = join(home, 'sessions');
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    if (isPublic) await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });

    // Resume only what pi wrote; anything else (a codex thread id from before
    // the switch, a wiped home) starts fresh under a new id.
    const isResume = await sessionExists(sessionDir, ctx.sessionId);
    const sessionId = isResume ? ctx.sessionId : randomUUID();
    // F118: a public seat reads its memory but is not offered the save tool,
    // so its preamble names none.
    const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, {
      freshSession: !isResume, memoryReadOnly: isPublic,
    });

    // One credential file per spawn, inside this seat's own 0700 home: the
    // narrowest place the bridge can still read. On a public seat that home is
    // the jail's state directory, which is why pi gets no read tool there. The
    // value the server receives still travels on fd 3 (pi-mcp-client's fd
    // channel); the file is where the launcher puts it.
    const credential = writeCredentialFile(ctx.runtimeToken, {
      agentName: ctx.agentName || 'agent',
      root: join(home, 'credentials'),
    });
    let proxy = null;
    try {
      // A public pi never holds the provider key: it talks to a loopback proxy
      // with a per-turn token, and the proxy, in this process, adds the key and
      // pins the model (the same shape as Goose and Qwen).
      if (isPublic) {
        proxy = await (ctx._startProviderProxy || startProviderProxy)({
          provider: { baseURL: provider.baseUrl },
          ...(keyFile ? { keyFile } : { keyMaterial: baseEnv[provider.apiKeyEnv] }),
          adapterLabel: 'pi',
          pinnedModel: model,
        });
      }
      await writeFile(join(agentDir, 'models.json'), `${JSON.stringify(buildModelsJson(
        proxy ? { ...provider, baseUrl: proxy.baseURL } : provider, model,
      ), null, 2)}\n`, { mode: 0o600 });

      const unavailableMcp = [];
      const mcpReadDirectories = [];
      const grantBrokers = [];
      const servers = resolveMcpServers(ctx.environment?.mcp, {
        ...ctx,
        credentialFile: credential?.path || null,
        credentialDir: credential?.dir || null,
        publicSeat: isPublic,
        unavailableMcp,
        mcpReadDirectories,
        grantBrokers,
      });
      if (unavailableMcp.length) throw publicMcpUnavailableError(unavailableMcp);
      if (keyFile && isPublic) {
        refuseKeyFileInJail(keyFile, [home, packageRoot, EXTENSION_CODE_ROOT, ...mcpReadDirectories]);
      }
      const childEnv = isPublic ? {
        // A scrubbed environment: nothing of the operator's crosses into the
        // jail, and the provider variable holds the proxy's token, not the key.
        ...safeEnv(baseEnv),
        HOME: home,
        TMPDIR: join(home, 'tmp'),
        PI_CODING_AGENT_DIR: agentDir,
        PI_SKIP_VERSION_CHECK: '1',
        PI_OFFLINE: '1',
        [provider.apiKeyEnv]: proxy.token,
      } : {
        ...baseEnv,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SKIP_VERSION_CHECK: '1',
        // A variable NAME, never its value. The always-loaded extension uses
        // this to scrub custom provider keys as well as the default LiteLLM key.
        COMMONLY_PI_PROVIDER_KEY_ENV: provider.apiKeyEnv,
        ...(ownKey ? { [provider.apiKeyEnv]: ownKey } : {}),
      };
      // This seat brought its own key, so it has no use for ours.
      if (ownKey) delete childEnv[DEFAULT_PROVIDER.apiKeyEnv];
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
        publicSeat: isPublic,
      });
      // Shell isolation must not depend on whether this turn declares MCP. A
      // public turn has no shell at all, so it loads no shell extension (that
      // extension registers a `bash` tool of its own).
      if (!isPublic) args.splice(args.length - 1, 0, '-e', SHELL_ENV_PATH);

      // The public jail wraps pi itself. The bridge is an in-process pi
      // extension, so every MCP server it starts is a child of the jailed
      // process, and a Seatbelt profile is inherited across fork and exec: there
      // is no second spawn here, and nothing pi launches runs outside it.
      let command = 'pi';
      let spawnArgs = args;
      if (isPublic) {
        [command, ...spawnArgs] = (ctx._wrapArgvWithSeatbelt || wrapArgvWithSeatbelt)([binary, ...args], {
          workspacePath: ctx.cwd,
          workspaceAccess: resolvePublicSandboxMode(sandbox, platform) === 'read-only' ? 'read' : 'write',
          executablePath: binary,
          executablePaths: nodePath ? [nodePath] : [],
          statePath: home,
          loopbackNetworkPorts: [proxy.port],
          // Public seat: the CLI made this workspace, so it is pinned (F197).
          pinWorkspace: true,
          readOnlyDirectories: [packageRoot, EXTENSION_CODE_ROOT, ...mcpReadDirectories],
          // The jailed pi holds the seat token in memory (the bridge reads it),
          // so nothing it starts may inspect it.
          processInfo: 'self',
        });
      }

      const reply = await runPi({
        command,
        args: spawnArgs,
        cwd: ctx.cwd,
        env: childEnv,
        payload: servers.length ? JSON.stringify(servers) : undefined,
        timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
        credentials: proxy ? [...credentials, proxy.token] : credentials,
        spawnImpl: ctx._spawnImpl, // test seam only — do not use in production
        // F175c: a turn holding a grant broker keeps its credential file only
        // until pi has loaded its extensions. The first layer is inside pi: the
        // bridge deletes the directory before its factory returns, which pi
        // awaits before it creates the session (removeSpawnCredential), and
        // stops pi if it cannot. This is the second layer, at pi's first JSON
        // line (firstEventWatcher). It is async to pi, so it cannot be the one
        // that closes the file before a prompt; it normally finds the file gone,
        // and `force` tolerates that. It covers a turn whose bridge never ran. A
        // delete that does fail here still ends the turn.
        onFirstEvent: isPublic && grantBrokers.length && credential
          ? () => {
            try {
              (ctx._rmSync || rmSync)(credential.dir, { recursive: true, force: true });
            } catch (err) {
              throw new Error(
                `pi adapter: a public pi seat could not delete its connector credential (${credential.path}) once pi `
                + `had loaded its extensions: ${err?.message || err}; the turn was stopped so the credential does not `
                + 'stay readable during it',
              );
            }
          }
          : undefined,
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
      try { await proxy?.close(); } catch { /* best effort */ }
    }
  },
};
