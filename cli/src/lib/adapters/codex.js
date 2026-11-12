import { codexRuntimeInventory } from '../native-runtime-inventory.js';
import { observeSpawn, controlsFromArguments } from '../runtime-observation.js';
import { spawnInOwnGroup, wantsOwnProcessGroup } from '@commonlyai/seats/process-group';
import { describeTurnReap, markTurn, turnReapEnabled } from '@commonlyai/seats/turn-processes';
/**
 * codex adapter — wraps the local `codex` CLI as a Commonly agent.
 *
 * Contract: ADR-005 §Adapter pattern.
 *
 * Tested against codex-cli 0.125.0. The argv shape diverges from the
 * ADR-005 §Adapters-shipped-in-v1 table (which was written against an
 * earlier codex-acp variant): modern codex uses `codex exec resume <id>`
 * as a subcommand to continue a session, NOT a `--session <id>` flag.
 * If a future codex bumps the surface again, this adapter is the single
 * file to update.
 *
 * Output shape:
 *   - stdout = JSONL events: `{"type":"thread.started","thread_id":"<uuid>"}`,
 *     `{"type":"turn.started"}`, `{"type":"turn.failed","error":{...}}`, etc.
 *   - stderr = Rust tracing logs (timestamped), unrelated to model output.
 *
 * We capture session id from the `thread.started` event and read the agent's
 * final reply from the file written via `-o <FILE>` (codex's
 * `--output-last-message` short alias) — cleaner than parsing every
 * event-type variant the model can emit.
 *
 * Memory preamble: the adapter prepends the kernel's long-term memory context
 * on every turn. A fresh underlying session additionally receives the
 * read-first and durable-state-at-boundary cues, matching the Claude adapter
 * so the run loop's memory plumbing works identically across drivers.
 *
 * Purity (§Load-bearing invariants #1): input = argv + env + prompt;
 * output = text + session id. No direct network, no direct CAP calls.
 *
 * Test seam: `ctx._spawnImpl` is the sanctioned way for any adapter in this
 * codebase to swap `child_process.spawn` out for a mock. Same convention as
 * claude.js so future adapters stay uniform.
 *
 * Timeout caveat: SIGTERM at `timeoutMs`, then wait for `close`. If codex
 * ignores SIGTERM the promise never resolves — same caveat as claude.js;
 * SIGKILL escalation is a post-v1 concern (ADR-005 §Spawning semantics).
 */

import { requireSeatModel, seatModelRequired } from './seat-model.js';
import { meetsMinimumVersion, probeVersion, publicCodexVersionError } from './tested-version.js';
import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync,
} from 'fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { createRequire } from 'module';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve as pathResolve,
} from 'path';
import { CREDENTIAL_KEY, armCredentialRelease, writeCredentialFile } from '../credential-file.js';
import { MCP_READY_FILE_ENV, bridgeReadyFile, commonlyMcpReadyFile } from '../mcp-ready.js';
import { isOurGrantBroker } from '../grant-broker-guard.js';
import { BRIDGE_PATH } from './codex-broker-bridge.mjs';
import { brokerBridgeEntry } from './broker-bridge-entry.js';
import { supportedGitHooks } from '../commit-attribution.js';
import { WORKSPACE_GIT_SERVER_NAME, confinedWorkspaceGitServer, workspaceGitEnabled } from '../workspace-git.js';
import { deliverSeatCredential, withholdRuntimeCredential } from '../mcp-credential-delivery.js';
import { prepareMcpSpawn, publicMcpUnavailableError, selectedMcpVersionDir } from '../mcp-home.js';
import { BACKGROUND_PROCESS_CUE, buildMemoryPreamble, ROW_SLICING_CUE } from '../memory-bridge.js';
import { resolveSkillSource, skillsAsText } from '../skill-prompt.js';
import { isLegacySandboxTrust, normalizeSandboxTrust, refuseWorkspaceTrust } from '../environment.js';
import { contains, realpathOfNearest, refuseWorkspaceHoldingTurnDirs } from '../sandbox/turn-dir.js';
import { refuseCodeRunningGitSetup } from '../sandbox/workspace-git-config.js';
import { codexTrustedPerimeter } from '../sandbox/codex-perimeter.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';
import { publicSeatWithheldTools } from '../public-withheld-tools.js';
import { startProviderProxy } from '../provider-proxy.js';
import { resolveLaunch, resolveMcpCommand, resolveWindowsCommandWithReason } from '../windows-command.js';
import { codexContextTokens, codexHomeFor, codexRolloutPath } from '../session-recycle.js';

// Default timeout for a single codex spawn (exec mode).
//
// 2026-05-20 smoke surface: Cody's cycle-0 research task ran 15+ web
// searches across openai/codex release notes (a legitimate research
// workload) and was SIGTERM'd at exactly 300_000ms — the adapter killed
// her before she could synthesize the final reply. 5 minutes is too
// tight for codex `exec` mode under real tool-use; the bigger model
// (gpt-5.4) + web.run + reasoning is just slower than a chat turn.
// Bumping to 15 minutes gives multi-step research / repo investigation
// room to finish without disabling the cap (pathological hangs still
// SIGTERM).
//
// Operators can override via the COMMONLY_AGENT_RUN_TIMEOUT_MS env var
// without rebuilding (caller-supplied `ctx.timeoutMs` still wins).
// Invalid / non-positive values fall through to the default rather
// than disabling the timeout entirely.
const DEFAULT_TIMEOUT_MS = (() => {
  const fallback = 15 * 60 * 1000;
  const raw = process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS;
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
})();

const buildPrompt = buildMemoryPreamble;

// ── MCP wiring — codex consumes MCP servers via `-c mcp_servers.*` overrides ─
//
// Same substitution contract as claude.js (see that file for the placeholder
// rationale): ${COMMONLY_AGENT_TOKEN} / ${COMMONLY_API_URL} in the declared
// env spec are replaced with the wrapper's per-(agent, pod) runtime values at
// spawn time. Before this block the codex adapter silently ignored
// `environment.mcp`, so a codex agent had NO sanctioned posting tool — the
// 2026-07-22 as-operator attribution incident was a codex agent falling back
// to the operator's CLI profile because commonly_* tools were never wired.
//
// Codex-specific constraints:
//   - stdio/command servers only (no url transport here); url-only entries
//     are skipped rather than half-wired. The one exception is our grant
//     broker, which runs behind a stdio bridge (bridgeGrantBroker, F175b).
//   - Only entries that DECLARE stdio (or name no transport) are emitted, even
//     when they also carry a `command`. `auditDeclaredMcp` classifies by
//     `transport` and never judges the command of an entry that declared an
//     http one, so emitting it here executes a command the guard did not
//     approve — a case measured on 2026-09-18.
//   - Token-bearing values ride through `env_vars`, never a `-c ...env=...`
//     argv override. Command lines are visible to other same-user processes
//     unless the OS sandbox blocks process inspection; keeping bearer tokens
//     out of argv is an independent defense.
const SUBSTITUTION_KEYS = ['COMMONLY_AGENT_TOKEN', 'COMMONLY_TOKEN_FILE', 'COMMONLY_API_URL', 'COMMONLY_INSTANCE_URL'];
const PLACEHOLDER_RE = /\$\{(COMMONLY_[A-Z_]+)\}/g;

const substitutePlaceholders = (value, ctx) => {
  if (typeof value !== 'string') return value;
  if (!value.includes('${COMMONLY_')) return value;
  const subs = {
    COMMONLY_AGENT_TOKEN: ctx.runtimeToken || '',
    // The path, not the token: a declared server that can open a file reads the
    // credential from there, and the PATH is not a secret, so it may ride in the
    // argv override below (TASK-083).
    COMMONLY_TOKEN_FILE: ctx.credentialFile || '',
    COMMONLY_API_URL: ctx.instanceUrl || '',
    COMMONLY_INSTANCE_URL: ctx.instanceUrl || '',
  };
  return value.replace(PLACEHOLDER_RE, (whole, key) => (
    SUBSTITUTION_KEYS.includes(key) && subs[key] ? subs[key] : whole
  ));
};

// JSON string escaping is a valid subset of TOML basic-string escaping, so
// JSON.stringify doubles as the TOML quoter for command/args/env values.
const toml = (s) => JSON.stringify(String(s));

const HTTP_TRANSPORTS = new Set(['http', 'streamable-http']);

// F175b: the grant broker is a Streamable HTTP server and codex runs stdio
// servers here, so the broker is wired as OUR stdio bridge
// (broker-bridge-entry.js). Whether this seat may hold the broker at all was
// decided before the adapter (grant-broker-guard.js).
const bridgeGrantBroker = (server, ctx) => {
  const entry = brokerBridgeEntry(server, ctx);
  if (entry.skip) {
    // eslint-disable-next-line no-console
    console.warn(`[codex] grant broker ${server.name}: ${entry.skip}, so it is not wired for this spawn.`);
    return null;
  }
  // F460: the bridge reads the credential once and says so in its ready file.
  const readyPath = bridgeReadyFile(server, ctx);
  if (readyPath) entry.env = { ...entry.env, [MCP_READY_FILE_ENV]: readyPath };
  return [
    '-c', `mcp_servers.${server.name}.command=${toml(entry.command)}`,
    // The broker parks every write for the owner's approval itself, so codex
    // approving the call is the same boundary the stdio servers get below.
    '-c', `mcp_servers.${server.name}.default_tools_approval_mode="approve"`,
    '-c', `mcp_servers.${server.name}.args=[${entry.args.map(toml).join(', ')}]`,
    '-c', `mcp_servers.${server.name}.env={${Object.entries(entry.env).map(([key, value]) => `${key} = ${toml(value)}`).join(', ')}}`,
  ];
};

const buildMcpOverrideArgs = (mcpServers, ctx = {}) => {
  const flags = [];
  const forwardedEnv = {};
  const unavailableMcp = [];
  const mcpReadDirectories = [];
  for (const server of mcpServers || []) {
    const transport = typeof server?.transport === 'string' ? server.transport.trim().toLowerCase() : 'stdio';
    if (server?.name && HTTP_TRANSPORTS.has(transport)
      && isOurGrantBroker(server, { instanceUrl: ctx.instanceUrl })) {
      const bridged = bridgeGrantBroker(server, ctx);
      if (bridged) {
        flags.push(...bridged);
        // A public seat's MCP children run under its permission profile; the
        // bridge imports node builtins only, so the file is all it reads.
        if (ctx.publicSeat) mcpReadDirectories.push(BRIDGE_PATH);
      }
      continue;
    }
    if (!server?.name || transport !== 'stdio'
      || !Array.isArray(server.command) || !server.command.length) continue;
    // TASK-174: the command that will EXECUTE — the warmed build from the seat's
    // MCP home when there is one — and the credential channel is decided on that
    // same command, so the two can never disagree about which release runs. The
    // rewrite is before `substitutePlaceholders` because it introduces no
    // placeholder: it is a path this host resolved.
    const spawnCommand = prepareMcpSpawn(server.command, {
      apiUrl: ctx.instanceUrl, publicSeat: ctx.publicSeat,
    });
    if (!spawnCommand) {
      unavailableMcp.push(server.name);
      continue;
    }
    // A declared credential is rewritten to the file channel before anything is
    // substituted, so for our server the token is not token-bearing at all: it
    // lands in `env={...}` as a path and never reaches `env_vars`, which is the
    // one path by which the value ends up in codex's own environment and from
    // there in every MCP child it spawns (TASK-083, measured on a live codex
    // seat before the change).
    let declaredEnv = deliverSeatCredential({ ...server, command: spawnCommand }, {
      credentialFile: ctx.credentialFile,
      label: 'codex',
    }).env;
    // Win32 only: codex spawns the server without a shell, so an `npx.cmd` is
    // resolved to its target here (#2141). Identity on every other platform.
    const [command, ...rest] = resolveMcpCommand(
      spawnCommand.map((a) => substitutePlaceholders(a, ctx)),
      ctx.commandResolution,
      { label: 'codex', name: server.name },
    );
    // The doc block above promises bearer tokens never ride in argv, and this is
    // the place that had to hold it: an env value that carries the token is
    // diverted to env_vars, but a COMMAND ARGUMENT has no such route — codex
    // substitutes it literally, and a command line is readable by every
    // same-user process. So an entry that needs the token in its argv is
    // refused whole (skipped, with the reason) rather than half-wired: emitting
    // its other flags would leave a server the guard approved and the seat
    // cannot use, and emitting this one would publish the secret. Measured
    // before writing this: substitution did put `cm_agent_*` into
    // `mcp_servers.<name>.args` on the -c command line (TASK-083).
    const carriesTokenInArgv = (value) => !!ctx.runtimeToken
      && typeof value === 'string'
      && value.includes(ctx.runtimeToken);
    if (carriesTokenInArgv(command) || rest.some(carriesTokenInArgv)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[codex] MCP server ${server.name} wants the seat credential as a command `
        + 'argument, where codex substitutes a literal and every same-user process '
        + 'can read it. Skipping that entry: declare the credential on the entry\'s '
        + 'env, where it rides as a file path instead of a value.',
      );
      continue;
    }
    // F460: on a public seat our server names the file it writes once it has
    // read the credential (a path, not a secret). An older warm build refuses,
    // and so does another server handed the credential path. Named only for an
    // entry that is wired, so a skipped one is never waited for.
    const readyPath = commonlyMcpReadyFile(server, spawnCommand, ctx, { env: declaredEnv });
    if (readyPath) declaredEnv = { ...declaredEnv, [MCP_READY_FILE_ENV]: readyPath };
    flags.push('-c', `mcp_servers.${server.name}.command=${toml(command)}`);
    const versionDir = ctx.publicSeat && selectedMcpVersionDir(spawnCommand);
    if (versionDir) mcpReadDirectories.push(versionDir);
    // The user opted into every server present in the environment spec.
    // Public permission profiles + approval_policy=never otherwise auto-deny
    // side-effecting MCP calls, silently removing the agent's Commonly tools.
    // Mirror Claude's --allowedTools behavior: declared MCP servers are the
    // capability boundary, and all of their tools are non-interactively
    // approved inside that boundary.
    flags.push(
      '-c',
      `mcp_servers.${server.name}.default_tools_approval_mode="approve"`,
    );
    // ...except the tools no public seat is offered (public-withheld-tools.js),
    // self-install and the memory writes included (F118). This list is argv on
    // every spawn, `exec resume` too, so a resumed thread gets this turn's list.
    if (ctx.publicSeat) {
      flags.push('-c', `mcp_servers.${server.name}.disabled_tools=[${publicSeatWithheldTools(ctx).map(toml).join(',')}]`);
    }
    if (rest.length) {
      flags.push('-c', `mcp_servers.${server.name}.args=[${rest.map(toml).join(',')}]`);
    }
    const envEntries = [];
    const envVars = [];
    for (const [key, rawValue] of Object.entries(declaredEnv)) {
      const value = substitutePlaceholders(rawValue, ctx);
      const carriesRuntimeToken = !!ctx.runtimeToken
        && typeof value === 'string'
        && value.includes(ctx.runtimeToken);
      if (carriesRuntimeToken) {
        // Codex reads these as its own credential or model route, so a value
        // forwarded under one of these names would be sent to the model endpoint.
        // Compared in upper case on every platform: Windows env names are
        // case-insensitive, and refusing a lower-case spelling elsewhere costs nothing.
        if (CODEX_OWN_AUTH_ENVS.includes(key.toUpperCase())) {
          throw new Error(
            `codex MCP server ${server.name} sets ${key} to the seat token; codex reads ${key} `
            + 'as its own credential, so declare the token under another name',
          );
        }
        if (forwardedEnv[key] !== undefined && forwardedEnv[key] !== value) {
          throw new Error(
            `codex MCP servers declare conflicting token-bearing values for env var ${key}`,
          );
        }
        forwardedEnv[key] = value;
        envVars.push(key);
      } else {
        envEntries.push(`${key} = ${toml(value)}`);
      }
    }
    if (envEntries.length) {
      flags.push('-c', `mcp_servers.${server.name}.env={${envEntries.join(', ')}}`);
    }
    if (envVars.length) {
      flags.push('-c', `mcp_servers.${server.name}.env_vars=[${envVars.map(toml).join(',')}]`);
    }
  }
  if (Object.keys(forwardedEnv).length > 0) {
    // The value is forwarded only for a declaration that needs the token as a
    // LITERAL somewhere a file path is not a value — command args, or a string
    // that merely contains it. That is the measured carve-out (TASK-082), and it
    // is not silent: this is the seat whose environment still carries a secret.
    // eslint-disable-next-line no-console
    console.warn(
      `[codex] this declaration needs ${CREDENTIAL_KEY} as a literal (command args, or a `
      + 'value that contains it), so the token is forwarded to codex for this spawn '
      + "and every MCP child inherits it. Put the credential on the entry's env to "
      + 'get the file channel.',
    );
  }
  return { flags, forwardedEnv, unavailableMcp, mcpReadDirectories };
};

const PUBLIC_PERMISSION_PROFILE = 'commonly_public';
const PUBLIC_SANDBOX_MODES = new Set(['workspace', 'read-only']);
// F387: a private seat outside a cloud-codex pod. Not a sandbox for untrusted
// input: public seats keep commonly_public.
const PRIVATE_PERMISSION_PROFILE = 'commonly_private';

const statOrNull = async (path) => {
  try {
    return await lstat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
};

// Codex reads $CODEX_HOME/AGENTS.md before model-generated commands enter the
// OS sandbox. Pointing a public run at the operator's normal ~/.codex would
// therefore expose global private instructions even though shell reads of
// ~/.codex are denied. Give every public wrapper identity its own persistent
// Codex home for sessions/state, with only an auth symlink back to the
// operator credential. On macOS the symlink lives under ~/.commonly, which the
// permission profile denies to model-generated commands; on Linux (below) its
// target, ~/.codex, is denied instead.
//
// On Linux the home cannot sit under ~/.commonly. Codex (0.164 and later)
// runs its file helper by exec'ing `$CODEX_HOME/tmp/arg0-linux/.../
// codex-linux-sandbox` inside bwrap, and grants read on that one file, but a
// denied ancestor always wins, so the profile's ~/.commonly deny made every
// public session fail at bootstrap with "bwrap: execvp ... Permission denied".
// Outside every granted root the home is still unreadable to model commands:
// Codex binds the helper file alone, not the home around it (measured on
// codex-cli 0.164.0, where a home there reached the model call). That holds
// only while the workspace does not contain the home, so such a workspace is
// refused. macOS has no arg0 helper and keeps its homes where they were.
const LEGACY_CODEX_HOMES = (home) => join(home, '.commonly', 'codex-homes');

const stateHomeUnderCommonly = (ctx, home, seat = 'public') => Object.assign(new Error(
  `XDG_STATE_HOME (${ctx.env?.XDG_STATE_HOME}) puts the ${seat} Codex home under ${join(home, '.commonly')}, `
  + `which the ${seat} sandbox denies on Linux. Point it elsewhere or unset it.`,
), { code: 'state_home_under_commonly' });

const publicCodexHomesRoot = (ctx) => {
  const home = ctx._homeDir || homedir();
  if ((ctx._platform || process.platform) !== 'linux') return LEGACY_CODEX_HOMES(home);
  const stateHome = ctx.env?.XDG_STATE_HOME;
  const root = join(stateHome && isAbsolute(stateHome) ? stateHome : join(home, '.local', 'state'),
    'commonly', 'codex-homes');
  // An override that lands back under the denied tree would bring the
  // bootstrap failure above back with it. Checked here by name, and again
  // through symlinks before anything is created (preparePublicCodexHome).
  if (contains(pathResolve(home, '.commonly'), pathResolve(root))) throw stateHomeUnderCommonly(ctx, home);
  return root;
};

// F186: Codex on Linux refuses to create its sandbox helper under the temp
// folder it sees ("Refusing to create helper binaries under temporary dir"),
// so a seat whose home lands there (HOME or XDG_STATE_HOME under /tmp, as on
// a CI box or a throwaway container) failed every turn before the model, and
// three of those opened the circuit. Codex's temp folder is its own TMPDIR,
// else /tmp, compared as written; the real paths are compared as well, so a
// link either way is refused too. `_codexTempRoot` replaces it in tests.
// Linux only: Codex on macOS ran from a home under $TMPDIR (codex-cli 0.162.1,
// measured 2026-11-12), and walk recipes there often put HOME in the temp folder.
const codexTempRoot = (ctx, childEnv) => {
  if (ctx._codexTempRoot !== undefined) return ctx._codexTempRoot;
  const fromEnv = childEnv?.TMPDIR;
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : '/tmp';
};

const refuseCodexHomeUnderTemp = async (ctx, childEnv, home, seat) => {
  if ((ctx._platform || process.platform) !== 'linux') return;
  const root = codexTempRoot(ctx, childEnv);
  const [realRoot, realHome] = await Promise.all([realpathOfNearest(root), realpathOfNearest(home)]);
  if (!contains(pathResolve(root), pathResolve(home)) && !contains(realRoot, realHome)) return;
  throw Object.assign(new Error(
    `the ${seat} Codex home (${home}) is inside the temporary folder ${root}, where Codex refuses to set up `
    + 'its sandbox helper, so every turn would stop before the model. Set XDG_STATE_HOME (or HOME) to a folder '
    + `outside ${root} and start the agent again.`,
  ), { code: 'codex_home_under_temp' });
};

// An XDG_STATE_HOME under ~/.commonly throws above, and that tree is denied anyway.
const privatePublicHomesDeny = (ctx) => {
  if ((ctx._platform || process.platform) !== 'linux') return [];
  try {
    return [publicCodexHomesRoot(ctx)];
  } catch {
    return [];
  }
};

const operatorCodexHome = (ctx) => ctx.env?.CODEX_HOME
  || process.env.CODEX_HOME
  || join(homedir(), '.codex');

// F445: on Linux a private seat runs with a Codex home of its own, beside the
// public ones, so the folder its shell can see holds no other session's logs,
// databases or history: F444 denied a shared home entry by entry, from a
// listing taken when the turn's keys are built, and anything another session
// wrote there under a new name, or during a command, stayed readable. The home
// starts with no history: nothing is copied from the shared one, which holds
// other sessions' history, the thing being fenced off. What the agent is meant
// to remember lives in Commonly. Only the person's own setup is carried over,
// as symlinks Codex follows outside the sandbox: their login, config.toml (a
// private seat keeps its own config) and global AGENTS.md. macOS denies the
// shared home whole under Seatbelt and keeps running from it.
const PRIVATE_CODEX_HOMES = 'codex-private-homes';
const PRIVATE_HOME_LINKS = Object.freeze(['auth.json', 'config.toml', 'AGENTS.md']);

/** The shared Codex home a private seat's setup comes from. */
const privateSourceCodexHome = (ctx, env) => pathResolve(
  ctx.cwd || process.cwd(),
  env?.CODEX_HOME || join(env?.HOME || homedir(), '.codex'),
);

/**
 * Who a seat's own Codex home belongs to (F450): the seat's local key, as the
 * run loop names its sessions and state (F306). A second instance's is
 * `name@instance`, so it gets a home of its own; every other seat's is its
 * bare name, so every home made before this keeps its seat, including a seat
 * saved under its name that runs a non-default instance.
 */
export const codexHomeIdentity = (ctx) => ctx.seatKey || ctx.agentName || ctx.cwd || 'anonymous';

/** Where this private seat's own Codex home is, or null where it has none. */
export const privateCodexHomePath = (ctx) => {
  if (ctx._privateCodexHome) return ctx._privateCodexHome;
  const identity = codexHomeIdentity(ctx);
  const hash = createHash('sha256').update(`private:${identity}`).digest('hex').slice(0, 20);
  let publicRoot;
  try {
    publicRoot = publicCodexHomesRoot(ctx);
  } catch (error) {
    if (error?.code !== 'state_home_under_commonly') throw error;
    throw stateHomeUnderCommonly(ctx, ctx._homeDir || homedir(), 'private');
  }
  return join(dirname(publicRoot), PRIVATE_CODEX_HOMES, hash);
};

// F450: a login Codex keeps in the keyring is filed under the Codex home's own
// path and leaves no auth.json, so a seat in a home of its own can't reach it.
// Said once per process per home, at the first turn.
const keyringLoginNoted = new Set();
const KEYRING_STORE = /^\s*cli_auth_credentials_store\s*=\s*["'](keyring|auto)["']/m;
// Only the keys above the first table header are the top level.
const topLevelToml = (text) => text.split(/^\s*\[/m)[0];
const noteKeyringLogin = async (source, home) => {
  if (keyringLoginNoted.has(home)) return;
  keyringLoginNoted.add(home);
  if (await statOrNull(join(source, 'auth.json'))) return;
  const config = await readFile(join(source, 'config.toml'), 'utf8').catch(() => '');
  const store = topLevelToml(config).match(KEYRING_STORE)?.[1];
  if (!store) return;
  process.stderr.write(`[codex] this agent runs from a Codex home of its own (${home}). Your config.toml `
    + `sets cli_auth_credentials_store = "${store}" and there is no auth.json to link, so a login kept in `
    + 'the keyring can\'t reach it. '
    + 'To fix it, set cli_auth_credentials_store = "file" in your config.toml and run `codex login`.\n');
};

const preparePrivateCodexHome = async (ctx, childEnv) => {
  const source = privateSourceCodexHome(ctx, childEnv);
  const home = privateCodexHomePath(ctx);
  if (pathResolve(home) === source) throw new Error('a private Codex home must be apart from the shared CODEX_HOME');
  const workspacePath = pathResolve(ctx.cwd || process.cwd());
  const userHome = ctx._homeDir || homedir();
  const [workspace, realHome, realSource, realCommonly] = await Promise.all([
    // As in realpathOfNearest: only a missing workspace falls back to its own path.
    realpath(workspacePath).catch((error) => {
      if (error?.code === 'ENOENT') return workspacePath;
      throw error;
    }),
    realpathOfNearest(home),
    realpathOfNearest(source),
    realpathOfNearest(join(userHome, '.commonly')),
  ]);
  if (contains(workspace, realHome)) {
    throw new Error(`private codex agents cannot run in ${ctx.cwd}: it contains the agent's own Codex home `
      + `(${home}), which the sandbox would then expose. Run it in a project folder.`);
  }
  // Both are denied whole, and a home inside either would hide Codex's own
  // sandbox helper, so every turn would stop at start.
  if (contains(realSource, realHome) || contains(realCommonly, realHome)) {
    throw new Error(`a private Codex agent's own home (${home}) resolves inside `
      + `${contains(realSource, realHome) ? `the shared Codex home (${source})` : join(userHome, '.commonly')}, `
      + 'which its sandbox denies on Linux. Point XDG_STATE_HOME elsewhere or unset it.');
  }
  if (!ctx._privateCodexHome) await refuseCodexHomeUnderTemp(ctx, childEnv, home, 'private');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  for (const name of PRIVATE_HOME_LINKS) {
    const from = join(source, name);
    const to = join(home, name);
    const [fromStat, toStat] = await Promise.all([statOrNull(from), statOrNull(to)]);
    // A file the seat's Codex wrote in its own home is its own: kept.
    if (toStat && !toStat.isSymbolicLink()) continue;
    if (!fromStat) {
      // A link to a login the person removed would sign in through it anyway.
      if (toStat) await unlink(to);
      continue;
    }
    const current = toStat ? pathResolve(dirname(to), await readlink(to)) : null;
    if (current !== from) {
      if (toStat) await unlink(to);
      // Another turn of the same seat may have just made it.
      await symlink(from, to).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
    }
  }
  await noteKeyringLogin(source, home);
  await mkdir(join(home, 'tmp', 'arg0-linux'), { recursive: true, mode: 0o700 });
  // Every other private seat's home, as it stands now. One created during this
  // turn is denied from the next turn on: until then, what that seat's first
  // turn writes there stays readable to this turn's commands.
  const others = entriesOf(dirname(home)).filter((name) => name !== basename(home)).sort()
    .map((name) => join(dirname(home), name));
  // The links into the shared home, which is denied whole with their targets.
  const links = [];
  for (const name of PRIVATE_HOME_LINKS) {
    const stat = await statOrNull(join(home, name));
    if (stat?.isSymbolicLink() && pathResolve(home, await readlink(join(home, name))) === join(source, name)) links.push(name);
  }
  return { home, source, realSource, others, links };
};

// `login: false` is the proxy route (D250): codex authenticates with the
// per-turn token, so the public home gets no link to the person's Codex login,
// and a link an earlier turn left is removed.
const preparePublicCodexHome = async (ctx, childEnv, { login = true } = {}) => {
  const operatorHome = operatorCodexHome(ctx);
  const identity = codexHomeIdentity(ctx);
  const identityHash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  const homesRoot = publicCodexHomesRoot(ctx);
  const publicHome = ctx._publicCodexHome || join(homesRoot, identityHash);
  if (pathResolve(publicHome) === pathResolve(operatorHome)) {
    throw new Error('public codex home must be isolated from the operator CODEX_HOME');
  }

  // Checked before anything is created or moved, so a refused workspace
  // never receives the home or a migrated seat's sessions.
  if (!ctx._publicCodexHome && homesRoot !== LEGACY_CODEX_HOMES(ctx._homeDir || homedir())) {
    const home = ctx._homeDir || homedir();
    const [realRoot, realCommonly] = await Promise.all([realpathOfNearest(homesRoot), realpathOfNearest(join(home, '.commonly'))]);
    if (contains(realCommonly, realRoot)) throw stateHomeUnderCommonly(ctx, home);
    await refuseCodexHomeUnderTemp(ctx, childEnv, publicHome, 'public');
    const workspacePath = pathResolve(ctx.cwd || process.cwd());
    const [workspace, realHome] = await Promise.all([
      // As in realpathOfNearest: only a missing workspace falls back to its own path.
      realpath(workspacePath).catch((err) => {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return workspacePath;
        throw err;
      }),
      realpathOfNearest(publicHome),
    ]);
    if (contains(workspace, realHome)) {
      throw new Error(`public codex agents cannot run in ${ctx.cwd}: it contains the agent's own `
        + `Codex home (${publicHome}), which the sandbox would then expose. Run it in a project folder.`);
    }
  }

  // A Linux seat that ran before the move keeps its sessions, so a resumed
  // thread still resumes. Across filesystems it starts fresh instead, and
  // says so: the old sessions stay where they were, untouched, and a copy
  // that failed halfway would leave a home later runs never migrate again.
  const legacyHome = join(LEGACY_CODEX_HOMES(ctx._homeDir || homedir()), identityHash);
  if (!ctx._publicCodexHome && legacyHome !== publicHome && !(await statOrNull(publicHome))) {
    const legacy = await statOrNull(legacyHome);
    if (legacy?.isDirectory()) {
      await mkdir(homesRoot, { recursive: true, mode: 0o700 });
      try {
        await rename(legacyHome, publicHome);
      } catch (err) {
        if (err?.code !== 'EXDEV') throw err;
        console.warn(
          `[codex] ${legacyHome} is on another filesystem from ${publicHome}; starting a fresh Codex home. `
          + 'Earlier sessions stay in the old home and will not resume; move it there by hand to keep them.',
        );
      }
    }
  }

  await mkdir(publicHome, { recursive: true, mode: 0o700 });
  await chmod(publicHome, 0o700);

  const sourceAuth = join(operatorHome, 'auth.json');
  const targetAuth = join(publicHome, 'auth.json');
  const sourceStat = await statOrNull(sourceAuth);
  const targetStat = await statOrNull(targetAuth);
  if (targetStat && !targetStat.isSymbolicLink()) {
    throw new Error(`refusing to replace non-symlink public Codex credential: ${targetAuth}`);
  }
  if (!login) {
    if (targetStat) await unlink(targetAuth);
  } else if (sourceStat) {
    const currentTarget = targetStat
      ? pathResolve(dirname(targetAuth), await readlink(targetAuth))
      : null;
    if (currentTarget !== pathResolve(sourceAuth)) {
      if (targetStat) await unlink(targetAuth);
      await symlink(sourceAuth, targetAuth);
    }
  } else if (targetStat) {
    // A stale symlink could unexpectedly authenticate through an old home
    // after the operator intentionally logged out. Remove it and let Codex
    // fail closed with its normal "not logged in" error.
    await unlink(targetAuth);
  }
  // Model commands are sandboxed through the arg0 helper in this folder, a
  // symlink to Codex's own binary, and unlike the file helper that path grants
  // itself neither the folder nor the binary. Without both, every command
  // fails with "bwrap: execvp ... No such file or directory" (measured on
  // codex-cli 0.164.0 with a user-prefix npm install). Only where the home
  // sits outside every deny can the folder's grant take effect.
  const helperReadPaths = [];
  if (homesRoot !== LEGACY_CODEX_HOMES(ctx._homeDir || homedir())) {
    const helperDirectory = join(publicHome, 'tmp', 'arg0-linux');
    await mkdir(helperDirectory, { recursive: true, mode: 0o700 });
    helperReadPaths.push(helperDirectory);
    // Looked up on the PATH the child gets, so the grant names the binary it runs.
    const binary = (ctx._codexNativeBinary || codexNativeBinary)(childEnv);
    if (binary) helperReadPaths.push(binary);
  }
  return { home: publicHome, helperReadPaths };
};

// The native binary `codex` on PATH runs: itself when it is one, or the one
// the npm launcher (`bin/codex.js`) picks, resolved the way that launcher does.
// Only the Linux targets are named because only the Linux helper needs this.
const LINUX_CODEX_TARGETS = { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' };

export const codexNativeBinary = (env) => {
  const onPath = String(env?.PATH || '').split(delimiter).filter(Boolean)
    .map((dir) => join(dir, 'codex'))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!onPath) return null;
  const real = realpathSync(onPath);
  if (basename(real) !== 'codex.js') return real;
  const target = LINUX_CODEX_TARGETS[process.arch];
  if (!target) return null;
  const packageRoot = dirname(dirname(real));
  let vendorRoot = join(packageRoot, 'vendor');
  try {
    const platformPackage = createRequire(real).resolve(`@openai/codex-linux-${process.arch}/package.json`);
    vendorRoot = join(dirname(platformPackage), 'vendor');
  } catch { /* the launcher falls back to its own vendor folder too */ }
  const binary = join(vendorRoot, target, 'bin', 'codex');
  return existsSync(binary) ? realpathSync(binary) : null;
};

// A public seat ran with none of its declared skills: this adapter never read
// `environment.skills`, so every outsider's Codex worked without the house
// rules buildDefaultEnvironment declares for it (found 2026-10-20 beside the
// Claude half of the same gap, #2354). `codex exec` has no skill loader a
// public seat can use, but it reads $CODEX_HOME/AGENTS.md as the user's own
// instructions, and the public home is one this CLI owns. Measured on
// codex-cli 0.162.1 with this adapter's public flags (`--ignore-user-config`
// skips config.toml only): a marker in that file came back verbatim on a new
// thread, and a changed marker came back on `exec resume` of the same thread,
// so a seat picks the skills up on its next turn either way.
//
// `skills.claude` is ADR-008's SKILL.md list ("drivers copy or symlink as
// appropriate"); Codex reads the same format, so no new key. Rewritten each
// spawn (staged, then renamed, so a concurrent read never sees half a file),
// and removed when nothing is declared so a dropped skill stops applying.
// The cap is our own, set at Codex's `project_doc_max_bytes` (32768 in
// codex-cli 0.162.1's shipped default config, read from the binary 2026-10-21).
// It is not a limit Codex applies to this file. At rust-v0.162.1 the global
// `$CODEX_HOME/AGENTS.md` is read whole and trimmed
// (codex-home/src/instructions/mod.rs) and passed in as user instructions,
// outside the project-doc budget, which counts only the project AGENTS.md files
// discovered from the working directory (core/src/agents_md.rs,
// load_project_instructions). So the skills never share a budget with a
// workspace's own AGENTS.md, and nothing past the cap would be cut. The cap is
// what keeps the injected text to the size Codex allows a project doc. It
// bounds the file as written, final newline included, and a skill that would
// cross it is left out whole.
const PUBLIC_CODEX_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

const writePublicCodexInstructions = async (publicHome, ctx) => {
  // Codex loads this file before AGENTS.md when it exists. Clear any leftover
  // override on every spawn so it cannot shadow the seat's declared skills.
  await rm(join(publicHome, 'AGENTS.override.md'), { force: true });
  const declared = Array.isArray(ctx.environment?.skills?.claude) ? ctx.environment.skills.claude : [];
  const baseDir = ctx.cwd || process.cwd();
  const sources = declared.map((source) => resolveSkillSource(source, baseDir));
  const included = [];
  const text = await skillsAsText(
    sources,
    {
      maxBytes: PUBLIC_CODEX_INSTRUCTIONS_MAX_BYTES,
      label: 'codex',
      trailer: '\n',
      onIncluded: (source) => included.push(source),
    },
  );
  const target = join(publicHome, 'AGENTS.md');
  if (!text) {
    await rm(target, { force: true });
    ctx.onSkillsLinked?.({ mounted: [], conflicted: sources.map((path) => ({ path, reason: 'not-inlined' })) });
    return;
  }
  const staged = `${target}.${process.pid}.tmp`;
  await writeFile(staged, text, { encoding: 'utf8', mode: 0o600 });
  await rename(staged, target);
  ctx.onSkillsLinked?.({
    mounted: included,
    conflicted: sources.filter((source) => !included.includes(source)).map((path) => ({ path, reason: 'not-inlined' })),
  });
};

// A public Codex seat runs with Commonly's tools, the shell, file edits and
// view_image. Those three read and write through the permission profile, as
// measured on each version named below; these keys turn off Codex's other
// built-ins, which claude.js does with its deny list.
//
// - `web_search` is the top-level mode, and "disabled" also drops `web__run`
//   from the `exec` tool of code-mode models.
// - `features.multi_agent` removes the agent tools from a model on the v1 agent
//   tools, but a thread started without it keeps them when resumed, so
//   `agents.max_depth=0` covers that thread. A model whose catalog entry says
//   `multi_agent_version: "v2"` keeps `collaboration.*` in its tool list whatever
//   these say, so the v2 cap is what stops it: at 1 the root thread fills it, and
//   spawn_agent returns "agent thread limit reached". `agents.max_threads` doesn't
//   do this, and only `model_catalog_json` takes the names out, which replaces
//   the whole catalog.
// - `features.goals` removes the goal tools. A goal is kept on the thread and
//   comes back in the next turn's context.
// - `features.plugins`, `features.apps` and `analytics.enabled` turn off plugins,
//   account apps and usage analytics, which a public seat has no use for.
//
// Measured against the tool list sent to the model, on codex-cli 0.162.1 with
// gpt-5.5, gpt-5.6 and gpt-6 models and on 0.159.3 with gpt-5.5 and gpt-6 models
// (adapters.codex.public-tools.test.mjs).
const PUBLIC_BUILTIN_TOOL_FLAGS = Object.freeze([
  '-c', 'web_search="disabled"',
  '-c', 'features.multi_agent=false',
  '-c', 'features.multi_agent_v2.max_concurrent_threads_per_session=1',
  '-c', 'features.goals=false',
  '-c', 'features.plugins=false',
  '-c', 'features.apps=false',
  '-c', 'analytics.enabled=false',
  '-c', 'agents.max_depth=0',
]);

// A public seat needs a tested Codex version: below this one it runs no turn.
// Tested on macOS with the real binary, through this adapter's public flags: the
// permission profile (shell and view_image, read and write, network off) and the
// tool list, on new and resumed threads, on 0.159.3 and 0.162.1. An older version
// isn't tested to this bar. A later one runs as it is, so the BYO workflows'
// 0.164.0 is allowed, though these checks have not been run on it, nor on Linux
// on any version.
export const PUBLIC_CODEX_MIN_VERSION = '0.159.3';

// The exact line `codex --version` printed on every version tested. Anything else
// counts as unread: a looser match could take a number from another line.
const parseCodexVersion = (stdout) => (
  /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m.exec(String(stdout))?.[1] || null
);

// The commit-attribution hooks a profile has to let the shell read: the hooks
// folder Commonly installs, and each executable hook the repository already had.
const commitHookReadPaths = (commitAttributionEnv) => {
  const commitHooksPath = commitAttributionEnv?.COMMONLY_AGENT_HOOKS_PATH || null;
  const originalHooksPath = commitAttributionEnv?.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH || null;
  const originalHookPaths = originalHooksPath
    ? supportedGitHooks()
      .map((hookName) => join(originalHooksPath, hookName))
      .filter((hookPath) => {
        try {
          accessSync(hookPath, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      })
    : [];
  return { commitHooksPath, originalHookPaths };
};

// Codex's default name filter treats GIT_CONFIG_KEY_n as sensitive, so the
// attribution keys are set again after filtering. Their values stay in the
// environment instead of riding argv.
const gitConfigKeyShellSet = (commitAttributionEnv) => Object.entries(commitAttributionEnv || {})
  .filter(([name]) => /^GIT_CONFIG_KEY_\d+$/.test(name))
  .map(([name, value]) => `${toml(name)}=${toml(value)}`);

const publicPermissionProfileFlags = (
  mode,
  commitAttributionEnv = null,
  mcpReadDirectories = [],
  codexHelperReadPaths = [],
  platform = process.platform,
  workspacePath = null,
) => {
  if (!PUBLIC_SANDBOX_MODES.has(mode)) {
    throw new Error(
      `public codex agents require sandbox.mode=workspace or read-only, got ${mode || 'unset'}`,
    );
  }
  const workspaceAccess = mode === 'read-only' ? 'read' : 'write';
  const { commitHooksPath, originalHookPaths } = commitHookReadPaths(commitAttributionEnv);
  // Preserve caller-supplied git config entries alongside the appended
  // hooksPath entry. The explicit allowlist below admits only these concrete
  // variable names, not arbitrary environment variables.
  const gitConfigEnv = Object.keys(commitAttributionEnv || {})
    .filter((name) => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name));
  const gitConfigKeySet = gitConfigKeyShellSet(commitAttributionEnv);
  // The profile denies $TMPDIR and /tmp, so a shell heredoc fails. Set for the
  // model's shell alone: codex, its MCP child and the per-turn folder keep the
  // host's temp root, which spawn refuses to find in the workspace. The
  // workspace is the one folder this shell already writes. zsh, the macOS
  // login shell codex runs, takes its heredoc file from TMPPREFIX and ignores
  // TMPDIR. A read-only seat has no such folder, so its heredocs keep failing.
  const shellTmpDir = workspaceAccess === 'write' && workspacePath
    ? [`${toml('TMPDIR')}=${toml(workspacePath)}`, `${toml('TMPPREFIX')}=${toml(join(workspacePath, 'zsh'))}`]
    : [];
  const shellSet = [...gitConfigKeySet, ...shellTmpDir];
  const filesystem = [
    '":minimal"="read"',
    '"~/.commonly"="deny"',
    '"~/.claude"="deny"',
    '"~/.codex"="deny"',
    '"~/.ssh"="deny"',
    '"~/.aws"="deny"',
    '"~/.config"="deny"',
    // macOS's temp root, where other sessions' temp dirs live. Codex reads
    // every key as a path for its own platform, and on Windows this one has
    // no drive, so Codex refused the whole profile and no turn ever ran
    // (byo-windows run 41996139905). Linux accepts it as a plain path.
    ...(platform === 'win32' ? [] : ['"/private/tmp"="deny"']),
    `":workspace_roots"={"."="${workspaceAccess}",".commonly/**"="deny",".codex/**"="deny","*.env"="deny","*/*.env"="deny","*/*/*.env"="deny","**/.npmrc"="deny","**/.yarnrc*"="deny"}`,
    ...(commitHooksPath ? [`${toml(commitHooksPath)}="read"`] : []),
    ...originalHookPaths.map((hookPath) => `${toml(hookPath)}="read"`),
    ...mcpReadDirectories.map((path) => `${toml(path)}="read"`),
    ...codexHelperReadPaths.map((path) => `${toml(path)}="read"`),
  ].join(',');
  const shellEnvironment = [
    'PATH', 'HOME', 'TMPDIR', 'TMPPREFIX', 'LANG', 'LC_*',
    ...(commitHooksPath ? [
      ...gitConfigEnv,
      'COMMONLY_AGENT_GIT_CONFIG_INDEX',
      'COMMONLY_AGENT_GIT_CONFIG_BASE_COUNT',
      'COMMONLY_AGENT_HOOKS_PATH',
      'COMMONLY_AGENT_ORIGINAL_HOOKS_PATH',
      'COMMONLY_AGENT_SEAT_NAME',
      'COMMONLY_AGENT_SEAT_ID',
      'COMMONLY_AGENT_ADAPTER',
      'COMMONLY_AGENT_MODEL',
      'COMMONLY_AGENT_EFFORT',
    ] : []),
  ];
  return [
    '-c', `default_permissions=${toml(PUBLIC_PERMISSION_PROFILE)}`,
    '-c', `permissions.${PUBLIC_PERMISSION_PROFILE}.filesystem={${filesystem}}`,
    '-c', `permissions.${PUBLIC_PERMISSION_PROFILE}.network.enabled=false`,
    // The MCP launcher receives explicitly forwarded env_vars separately.
    // `core` drops explicit GIT_CONFIG_* and hook metadata before include_only
    // can admit them. When attribution is active, inherit all then constrain
    // model shells to the exact allowlist below; keep Codex's default secret
    // filters enabled.
    '-c', `shell_environment_policy.inherit="${commitHooksPath ? 'all' : 'core'}"`,
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.include_only=${JSON.stringify(shellEnvironment)}`,
    // Codex's default name filter treats GIT_CONFIG_KEY_n as sensitive. Set
    // only those key names after filtering; their corresponding values stay
    // in the allowlisted environment instead of riding argv.
    ...(shellSet.length ? ['-c', `shell_environment_policy.set={${shellSet.join(',')}}`] : []),
  ];
};

// Host secrets a private seat's shell never reads. ~/.commonly holds every
// seat's tokens and state; the seat's own workspace sits under it and is
// admitted by the more specific workspace rule (on Linux too: measured on
// codex-cli 0.164.0, a write key inside a denied folder works there). The
// Codex home is privateCodexHomeDenies'. gh keeps working: on macOS its
// login is in the keychain, which a credential the seat itself uses has to be.
const PRIVATE_SECRET_DENIES = Object.freeze([
  '~/.commonly', '~/.claude', '~/.ssh', '~/.aws', '~/.gnupg',
  '~/.kube', '~/.docker', '~/.netrc', '~/.config/gcloud',
]);

const realOrSelf = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// F444: what the private profile denies of the Codex home the seat runs with.
// On macOS the home is denied whole. On Linux Codex execs its sandbox helper
// from `<home>/tmp/arg0-linux` inside bwrap, and a denied home stops every turn
// at start ("bwrap: execvp codex-linux-sandbox: Permission denied"; a read key
// for `tmp` under the denied home does not lift it). Measured with `codex
// sandbox` and a real turn on codex-cli 0.164.0, ubuntu-22.04. So there the
// home itself stays readable and everything in it is denied except the helper
// folder: each entry present now, and the names Codex writes later even while
// they are absent (a key for a missing path is accepted there). Codex's SQLite
// databases write a `-wal` file during the turn that holds their newest rows,
// other sessions' included, and SQLite removes it when the last connection
// closes; so every database name, listed or known, takes its `-wal`, `-shm`
// and `-journal` too. A database under a new name is listed, with those, from
// the next turn. No globs: Codex's `*` crosses `/`, and a glob that matched a
// file inside a folder already denied stopped every turn at start ("bwrap:
// Can't create file at …: Read-only file system", run 43103991434).
// `~/.codex` is denied whole when it isn't that home.
const CODEX_HOME_SECRET_NAMES = Object.freeze([
  'auth.json', 'config.toml', 'sessions', 'archived_sessions', 'history.jsonl', 'log',
  'session_index.jsonl', 'shell_snapshots', 'memories',
  'logs_2.sqlite', 'state_5.sqlite', 'goals_1.sqlite', 'queue_1.sqlite',
]);
const SQLITE_SIDECARS = Object.freeze(['-wal', '-shm', '-journal']);
const CODEX_HELPER_PATH = Object.freeze(['tmp', 'arg0-linux']);

const entriesOf = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// `links`: entries of the run home that are links into a home denied whole
// (F445). A key on one makes bwrap follow it into the hidden folder and stop
// every turn at start ("Can't create file at …/auth.json: No such file or
// directory", run 43114789288); its target is out of reach already.
export const privateCodexHomeDenies = ({
  codexHome = null, platform = process.platform, home = homedir(), links = [],
} = {}) => {
  const defaultHome = join(home, '.codex');
  const runHome = codexHome ? realOrSelf(codexHome) : null;
  const runsFromDefault = !runHome || runHome === realOrSelf(defaultHome);
  if (platform !== 'linux') return runsFromDefault ? ['~/.codex'] : ['~/.codex', runHome];
  const helperHome = runHome || realOrSelf(defaultHome);
  const denies = runsFromDefault ? [] : ['~/.codex'];
  // Deny every sibling of the helper path at each level, so only the path
  // itself stays reachable.
  let dir = helperHome;
  for (const [depth, keep] of CODEX_HELPER_PATH.entries()) {
    const names = new Set(entriesOf(dir));
    if (depth === 0) {
      CODEX_HOME_SECRET_NAMES.forEach((name) => names.add(name));
      [...names].filter((name) => /\.(sqlite|db)$/.test(name))
        .forEach((name) => SQLITE_SIDECARS.forEach((suffix) => names.add(`${name}${suffix}`)));
    }
    names.delete(keep);
    if (depth === 0) links.forEach((name) => names.delete(name));
    denies.push(...[...names].sort().map((name) => join(dir, name)));
    dir = join(dir, keep);
  }
  return denies;
};

// What a commit writes, and nothing that runs code. Codex keeps a workspace's
// `.git` read-only even inside a writable root, and only an explicit absolute
// key opens it (measured with `codex sandbox` on 0.162.1: the same key inside
// :workspace_roots did not). `config` and `hooks` stay read-only, because a
// hook or a config-defined program (core.fsmonitor, a filter) would run as the
// person in every later git command there, outside any sandbox; renaming over
// them is refused too (measured). A git worktree keeps its admin folder
// outside the workspace (`.git` is a file naming it), and a commit there also
// writes the shared repository's objects, refs and logs, and packed-refs when
// git repacks them. Read from the files git leaves, without running git.
// Measured: a worktree whose repository lies under the denied ~/.commonly
// can't commit (git can't resolve the path), whatever these keys are.
const gitAdminKeys = (workspace) => {
  if (!workspace) return [];
  const dotGit = join(workspace, '.git');
  const ownRepository = (dir) => {
    const real = realOrSelf(dir);
    return [
      [real, 'write'],
      [join(real, 'config'), 'read'],
      [join(real, 'config.worktree'), 'read'],
      [join(real, 'hooks'), 'read'],
    ];
  };
  try {
    if (statSync(dotGit).isDirectory()) return ownRepository(dotGit);
  } catch {
    return [];
  }
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (!pointer) return [];
    const gitDir = pathResolve(workspace, pointer);
    let commonDir = null;
    try {
      commonDir = pathResolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      // A linked gitdir that is a whole repository of its own.
      return ownRepository(gitDir);
    }
    const realGitDir = realOrSelf(gitDir);
    const realCommon = realOrSelf(commonDir);
    return [
      [realGitDir, 'write'],
      [join(realGitDir, 'config.worktree'), 'read'],
      ...['objects', 'refs', 'logs', 'packed-refs', 'packed-refs.lock']
        .map((name) => [join(realCommon, name), 'write']),
    ];
  } catch {
    // An unreadable `.git` file.
    return [];
  }
};

// F387: the profile for a private Codex seat outside a cloud-codex pod. It is
// the seat owner's own agent doing dev work, so the disk stays readable, the
// network is on and the environment is inherited (with Codex's secret-name
// filter on); what it removes is every host secret the seat doesn't use
// itself. It is not a sandbox for untrusted input: public seats keep
// commonly_public.
const privatePermissionProfileFlags = ({
  commitAttributionEnv = null,
  mcpReadDirectories = [],
  codexHelperReadPaths = [],
  platform = process.platform,
  workspace = null,
  tempRoots = [],
  shellTempDir = null,
  codexHome = null,
  home = homedir(),
  otherCodexHomes = [],
  codexHomeLinks = [],
} = {}) => {
  const { commitHooksPath, originalHookPaths } = commitHookReadPaths(commitAttributionEnv);
  const posix = platform !== 'win32';
  // The temp roots hold every seat's per-turn folder: its runtime token and the
  // reply file Codex posts from. So they are denied whole, and the shell gets
  // one folder of its own inside this turn's, as TMPDIR (and TMPPREFIX, which
  // zsh takes its heredoc files from). Codex, and the MCP child that reads the
  // token, run outside the profile. On Windows these keys have no drive.
  const deniedTemp = posix
    ? [...new Set(['/private/tmp', ...tempRoots.filter(Boolean).map(realOrSelf)])]
    : [];
  const shellTemp = posix && shellTempDir ? realOrSelf(shellTempDir) : null;
  const filesystem = [
    // Codex reads every key as a path for its own platform; on Windows "/" has
    // no drive and Codex would refuse the whole profile (as with /private/tmp
    // in publicPermissionProfileFlags).
    posix ? '"/"="read"' : '":minimal"="read"',
    ...[...PRIVATE_SECRET_DENIES, ...privateCodexHomeDenies({ codexHome, platform, home, links: codexHomeLinks }), ...otherCodexHomes]
      .map((path) => `${toml(path)}="deny"`),
    ...deniedTemp.map((path) => `${toml(path)}="deny"`),
    ...(shellTemp ? [`${toml(shellTemp)}="write"`] : []),
    '":workspace_roots"={"."="write",".commonly/**"="deny",".codex/**"="deny"}',
    ...gitAdminKeys(workspace).map(([path, mode]) => `${toml(path)}=${toml(mode)}`),
    ...(commitHooksPath ? [`${toml(commitHooksPath)}="read"`] : []),
    ...originalHookPaths.map((hookPath) => `${toml(hookPath)}="read"`),
    ...mcpReadDirectories.map((path) => `${toml(path)}="read"`),
    ...codexHelperReadPaths.map((path) => `${toml(path)}="read"`),
  ].join(',');
  const shellSet = [
    ...gitConfigKeyShellSet(commitAttributionEnv),
    ...(shellTemp
      ? [
        `${toml('TMPDIR')}=${toml(shellTemp)}`,
        `${toml('TMPPREFIX')}=${toml(join(shellTemp, 'zsh'))}`,
        // macOS's /usr/bin tools are xcrun shims, which keep a cache in the
        // user temp root (denied above) and print an error on every call
        // without this.
        `${toml('xcrun_db')}=${toml(join(shellTemp, 'xcrun_db'))}`,
      ]
      : []),
  ];
  return [
    '-c', `default_permissions=${toml(PRIVATE_PERMISSION_PROFILE)}`,
    '-c', `permissions.${PRIVATE_PERMISSION_PROFILE}.filesystem={${filesystem}}`,
    '-c', `permissions.${PRIVATE_PERMISSION_PROFILE}.network.enabled=true`,
    '-c', 'shell_environment_policy.inherit="all"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    ...(shellSet.length ? ['-c', `shell_environment_policy.set={${shellSet.join(',')}}`] : []),
  ];
};

// F188: the host's OpenAI-compatible model route, for a public seat. That seat
// runs with `--ignore-user-config`, so config.toml's `openai_base_url` never
// loads, and codex-cli 0.162.1 does not read the OPENAI_BASE_URL env either
// (Growth's D252 walk, 11-05): a host routed at LiteLLM or another
// OpenAI-compatible endpoint sent every turn to api.openai.com and got a 401.
// The env is the declaration, as ANTHROPIC_BASE_URL is for the claude adapter;
// buildArgs passes it on as `-c openai_base_url=...`, the top-level key the
// 0.162.1 binary carries. Only a plain http(s) URL: one carrying credentials,
// a query or a fragment could put a key into argv, so it is refused rather
// than trimmed, and the refusal does not echo the value. The key itself stays
// where codex already reads it (auth.json in the public home, or the env).
export const publicModelRouteBaseUrl = (source = {}) => {
  const raw = typeof source.OPENAI_BASE_URL === 'string' ? source.OPENAI_BASE_URL.trim() : '';
  if (!raw) return null;
  let url = null;
  try { url = new URL(raw); } catch { /* refused below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname
    || url.username || url.password || /[?#\s]/.test(raw)) {
    throw new Error('codex adapter: OPENAI_BASE_URL must be a plain http(s) URL with no credentials, '
      + 'query or fragment (e.g. https://litellm.example.com/v1); fix or unset it before a public seat runs.');
  }
  return raw;
};

// F188 guard: `openai_base_url` moves wherever the seat's credential goes, a
// ChatGPT session included (the built-in provider swaps only its default base
// for a ChatGPT login). So the route is forwarded only to a seat that signs in
// with an API key, and a ChatGPT session token is never pointed at a URL from
// the env. The public home links the operator's auth.json, so that file decides:
// its `auth_mode` alone is read (codex-cli 0.162.1 writes "apikey", "chatgpt",
// "chatgptAuthTokens", ...), the parsed object is dropped, and nothing else from
// it is kept or logged. Only "apikey" counts as a key; a file with any other
// mode, no mode, or that does not parse is treated as a login and fails closed,
// whatever OPENAI_API_KEY says, since codex prefers its stored login. With no
// auth.json, an OPENAI_API_KEY in the env is the key (a CODEX_API_KEY never gets
// here: it takes the proxy route below). A CODEX_ACCESS_TOKEN in the env is a
// token codex sends in place of a key, so it counts as a login whatever
// auth.json says.
const CODEX_OWN_AUTH_ENVS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL'];

const CHATGPT_ROUTE_IGNORED = 'OPENAI_BASE_URL is ignored while Codex is signed in with ChatGPT; '
  + 'use an API key for a custom route';

const envSet = (source, name) => typeof source[name] === 'string' && source[name].trim() !== '';

export const codexAuthKind = async (operatorHome, source = {}) => {
  if (envSet(source, 'CODEX_ACCESS_TOKEN')) return 'login';
  let text = null;
  try {
    text = await readFile(join(operatorHome, 'auth.json'), 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return 'login';
  }
  if (text === null) {
    return envSet(source, 'OPENAI_API_KEY') ? 'apikey' : 'none';
  }
  let mode = null;
  try { mode = JSON.parse(text)?.auth_mode ?? null; } catch { /* unreadable: a login */ }
  return mode === 'apikey' ? 'apikey' : 'login';
};

// D250: the F188 route leaves the key in codex's own environment. With
// CODEX_API_KEY in the seat's environment (codex's own name for an exec key),
// the key stays on the host behind the per-turn loopback proxy, as a Claude
// seat's ANTHROPIC_API_KEY does, and codex gets a provider entry naming the
// proxy plus a per-turn token in an env var of our own. Measured on 0.162.1
// with `--ignore-user-config`: these two `-c` overrides sent
// `POST <base_url>/responses` with `Authorization: Bearer $<env_key>`. The URL
// passes the same check as F188's. Without this key the seat takes F188's
// route or the person's Codex login, as before.
const CODEX_PROXY_PROVIDER = 'commonly_proxy';
const CODEX_PROVIDER_TOKEN_ENV = 'COMMONLY_CODEX_PROVIDER_TOKEN';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const publicProviderRoute = (source = {}) => {
  if (!envSet(source, 'CODEX_API_KEY')) return null;
  return {
    baseURL: publicModelRouteBaseUrl(source) || OPENAI_DEFAULT_BASE_URL,
    key: source.CODEX_API_KEY.trim(),
  };
};

const providerRouteFlags = (proxy) => {
  if (!proxy) return [];
  // codex appends `/responses` itself, so a trailing slash would double it.
  const baseUrl = proxy.baseURL.replace(/\/+$/, '');
  return [
    '-c', `model_provider=${toml(CODEX_PROXY_PROVIDER)}`,
    '-c', `model_providers.${CODEX_PROXY_PROVIDER}={name=${toml('Commonly host proxy')},`
      + `base_url=${toml(baseUrl)},env_key=${toml(CODEX_PROVIDER_TOKEN_ENV)},wire_api="responses"}`,
  ];
};

// Build the argv after the `codex` binary. Resume vs new turn is a
// subcommand-level distinction in modern codex, not an option flag — keep
// that detail isolated here so the spawn path stays linear.
const buildArgs = ({
  sessionId,
  prompt,
  outputFile,
  mcpFlags = [],
  publicSandboxMode = null,
  model = null,
  effort = null,
  commitAttributionEnv = null,
  mcpReadDirectories = [],
  codexHelperReadPaths = [],
  modelBaseUrl = null,
  providerProxy = null,
  platform = process.platform,
  workspacePath = null,
  trustedContainerPerimeter = false,
  operatorUnconfined = false,
  privateWorkspace = null,
  tempRoots = [],
  shellTempDir = null,
  privateCodexHome = null,
  privateHome = homedir(),
  privateOtherCodexHomes = [],
  privateCodexHomeLinks = [],
  loginFileStore = false,
}) => {
  const publicSandbox = publicSandboxMode !== null;
  // F387: a private seat keeps the flag below only in a cloud-codex pod, or
  // when its operator opted this run out of the OS sandbox (D245, native
  // Windows only: Codex can't enforce a profile's read denies there).
  const keepsOwnPolicy = trustedContainerPerimeter || operatorUnconfined;
  const privateProfile = !publicSandbox && !keepsOwnPolicy;
  // `--dangerously-bypass-approvals-and-sandbox` disables codex CLI's
  // bubblewrap (bwrap) sandbox + approval prompts. bwrap needs CAP_SYS_ADMIN
  // or unprivileged user-namespaces — neither available to standard k8s
  // containers without elevated securityContext. Without this flag, every
  // shell tool call (git, ls, pwd, ...) fails with "bwrap: Failed to make /
  // slave: Permission denied" inside cloud-codex pods (verified 2026-05-15).
  // The pod is the security perimeter — agent identity is isolated, workspace
  // is PVC-scoped, no host mounts. bwrap inside the pod is redundant.
  // Public laptop wrappers are different: untrusted pod content must never
  // inherit that bypass. Codex permission profiles provide a native
  // deny-by-default read/write/network boundary on macOS and Linux, on the
  // versions spawn admits (PUBLIC_CODEX_MIN_VERSION). Do not
  // pass legacy `--sandbox` alongside them: Codex documents that the legacy
  // mode disables permission-profile composition.
  //
  // F387 (TASK-280): the flag above belongs to a cloud-codex k8s pod, where
  // bwrap cannot run and the pod is the boundary, or to a run its operator
  // opted out (keepsOwnPolicy). Every other private seat gets
  // privatePermissionProfileFlags: readable disk, network on, host secret dirs
  // denied. It keeps the seat's own config and route (no --ignore-user-config),
  // since a private seat relies on its config.toml; the -c profile still wins
  // over config defaults (checked against sandbox_mode, default_permissions and
  // a user [permissions.*] table on codex-cli 0.162.1).
  const executionPolicy = publicSandbox
    ? [
      '--ignore-user-config',
      '--ignore-rules',
      ...publicPermissionProfileFlags(
        publicSandboxMode,
        commitAttributionEnv,
        mcpReadDirectories,
        codexHelperReadPaths,
        platform,
        workspacePath,
      ),
      ...providerRouteFlags(providerProxy),
      ...PUBLIC_BUILTIN_TOOL_FLAGS,
    ]
    : keepsOwnPolicy
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : privatePermissionProfileFlags({
        commitAttributionEnv,
        mcpReadDirectories,
        codexHelperReadPaths,
        platform,
        workspace: privateWorkspace,
        tempRoots,
        shellTempDir,
        codexHome: privateCodexHome,
        home: privateHome,
        otherCodexHomes: privateOtherCodexHomes,
        codexHomeLinks: privateCodexHomeLinks,
      });
  const common = [
    '--json',
    '--skip-git-repo-check',
    ...executionPolicy,
    // F188: only a public seat drops config.toml; a private one keeps its own
    // route there. In `common`, so it lands after `exec` / `exec resume <id>`,
    // the only position codex parses it from.
    ...(publicSandbox && modelBaseUrl ? ['-c', `openai_base_url=${toml(modelBaseUrl)}`] : []),
    ...(model ? ['--model', String(model)] : []),
    ...(effort ? ['-c', 'model_reasoning_effort=' + toml(effort)] : []),
    ...(loginFileStore ? ['-c', 'cli_auth_credentials_store="file"'] : []),
    ...mcpFlags,
    '-o',
    outputFile,
  ];
  // Approval policy is a global option in Codex 0.144, so it must precede
  // the `exec` subcommand. A denied operation is returned to the model;
  // non-interactive agents never hang waiting for an operator. A private seat
  // under its profile keeps its own config.toml, which may ask for approvals.
  const prefix = publicSandbox || privateProfile ? ['--ask-for-approval', 'never'] : [];
  if (sessionId) {
    // Place <sessionId> immediately after the `exec resume` subcommand so a
    // future codex parser change can't accidentally consume it as the value
    // of a preceding flag (e.g. -o). Codex's CLI signature is documented as
    // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`, and this ordering
    // matches that intent unambiguously regardless of clap version.
    return [...prefix, 'exec', 'resume', sessionId, ...common, prompt];
  }
  return [...prefix, 'exec', ...common, prompt];
};

// Stream-parse JSONL stdout. Codex emits one event per line; partial lines
// across chunk boundaries are buffered and flushed on the next newline.
const makeEventParser = () => {
  let buffer = '';
  let threadId = null;
  let turnFailedMessage = null;
  let turnCompleted = false;

  const consumeLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'thread.started' && evt.thread_id && !threadId) {
        threadId = evt.thread_id;
      } else if (evt.type === 'turn.completed') {
        turnCompleted = true;
      } else if (evt.type === 'turn.failed') {
        // Capture the most recent — codex may emit multiple before exit.
        turnFailedMessage = evt.error?.message || 'codex turn failed';
      }
    } catch {
      // Non-JSON lines on stdout are unexpected but not fatal — skip.
    }
  };

  const consume = (chunk) => {
    buffer += chunk.toString();
    let nl;
    // eslint-disable-next-line no-cond-assign
    while ((nl = buffer.indexOf('\n')) !== -1) {
      consumeLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  };

  const flush = () => {
    consumeLine(buffer);
    buffer = '';
  };

  return {
    consume,
    flush,
    get threadId() { return threadId; },
    get turnFailedMessage() { return turnFailedMessage; },
    get turnCompleted() { return turnCompleted; },
  };
};

/**
 * Provider keys this adapter's route can authenticate with. `env_key` in
 * `~/.codex/config.toml` names one of them (ADR-014 — the HTTPS layer is
 * redirected, the CLI's semantics are not), and the adapter cannot know which
 * one this seat uses, so it snapshots whichever are present. A failure tail that
 * echoes a key must not reach a pod (TASK-103).
 */
const CODEX_PROVIDER_KEY_ENVS = [
  'LITELLM_API_KEY',
  'LITELLM_MASTER_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
];

// What the turn will launch, asked for its version. 30 s, as in goose: a first
// launch after an upgrade can be slow. A failed probe isn't cached, so the next
// turn reads it again. `_codexVersion` and `_versionProbe` are test seams only.
const readCodexVersion = async (ctx, env) => {
  if (ctx._codexVersion !== undefined) return ctx._codexVersion;
  try {
    const { command, args } = resolveLaunch('codex', [], { env, ...ctx._commandResolution });
    return await probeVersion(command, {
      args, env, timeoutMs: 30000, parse: parseCodexVersion, ...ctx._versionProbe,
    });
  } catch {
    return null;
  }
};

// `ownGroup`: see runClaude in claude.js.
const runCodex = ({
  args, cwd, env, timeoutMs, credentials = [], spawnImpl = childSpawn, onSpawn, controls = {}, ownGroup = false,
  turnReap = turnReapEnabled(), commandResolution = {}, confined = false,
}) => new Promise((resolve, reject) => {  // stdio: ['ignore', 'pipe', 'pipe'] — without this, child_process.spawn
  // defaults stdin to a fresh pipe. Codex 0.125.0's `exec` then blocks on
  // `Reading additional input from stdin...` because it sees an open pipe
  // and waits for input that never arrives. Interactive runs are fine because
  // codex detects a TTY and uses the argv prompt directly. Setting stdin to
  // `'ignore'` gives codex /dev/null → immediate EOF → it falls back to the
  // argv prompt as intended. Surfaced live during ADR-005 Phase 2 smoke.
  // What the turn leaves running is stopped once it has closed (see claude.js).
  // A confined turn's leftovers are stopped whatever the keep setting says.
  const turn = markTurn(env ?? process.env, { enabled: turnReap, confined });
  // On Windows `npm i -g @openai/codex` leaves a `codex.cmd`; it is read and
  // its target spawned directly, never through cmd.exe, because the prompt is
  // the last argv element and is pod content (#2141). Identity elsewhere.
  const launch = resolveLaunch('codex', args, { env: turn.env, ...commandResolution });
  const proc = spawnInOwnGroup(spawnImpl, launch.command, launch.args, { cwd, env: turn.env, stdio: ['ignore', 'pipe', 'pipe'] }, { ownGroup });
  observeSpawn(proc, onSpawn, controls);
  let stderr = '';
  let timedOut = false;
  const events = makeEventParser();

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
  }, timeoutMs);

  proc.stdout?.on('data', (chunk) => events.consume(chunk));
  proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
  proc.on('close', (code) => {
    clearTimeout(timer);
    const reaped = describeTurnReap(turn.reap(proc));
    // eslint-disable-next-line no-console
    if (reaped) console.warn(`[codex] ${reaped}`);
    if (timedOut) return reject(new Error(`codex timed out after ${timeoutMs}ms`));
    events.flush();
    if (events.turnFailedMessage) {
      // Surface the model-side failure message verbatim — the run loop posts
      // it as the agent's reply so the user sees what went wrong rather than
      // a generic "non-zero exit" error. Verbatim is about the WORDING: the
      // tail still goes through the shared reader (TASK-103), so a message that
      // echoed a credential this spawn was handed is redacted before it can be
      // posted into a pod, and a status it names is attached for the circuit
      // breaker rather than left to a regex.
      return reject(adapterFailure('codex turn failed', events.turnFailedMessage, {
        credentials,
        limit: 2000,
      }));
    }
    if (code !== 0) {
      return reject(adapterFailure('codex', stderr.trim(), { credentials, exitCode: code, limit: 500 }));
    }
    resolve({ threadId: events.threadId, turnCompleted: events.turnCompleted });
  });
});

export default {
  get requiresModel() { return seatModelRequired(); },
  name: 'codex',
  // See claude.js for the rationale — identity-bearing runtime tag persisted
  // to AgentInstallation.config.runtime (paired with host:'byo') so a CLI-
  // attached Codex agent and a cloud-hosted Codex agent share the same
  // `runtimeType` and differ only on `host`.
  runtimeType: 'codex',

  inventory: codexRuntimeInventory,

  // `opts` is a test seam only: `_commandResolution` overrides the Windows
  // resolver's platform/env/fs. Production calls detect() with no argument.
  async detect(opts = {}) {
    try {
      const located = resolveWindowsCommandWithReason('codex', opts._commandResolution);
      if (!located.command) {
        // Windows only: a `codex.cmd` this CLI cannot read safely, or none.
        process.stderr.write(`codex adapter: ${located.reason}\n`);
        return null;
      }
      const res = spawnSync(located.command, [...located.args, '--version'], { encoding: 'utf8', timeout: 5000 });
      if (res.error || res.status !== 0) return null;
      // `codex --version` prints e.g. "codex-cli 0.125.0" — last token is
      // the version. Defensive against future format tweaks: if no
      // dotted-numeric token is found, fall back to the raw stdout.
      const stdout = (res.stdout || '').trim();
      const versionMatch = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
      const version = versionMatch ? versionMatch[1] : (stdout || 'unknown');
      if (located.source) return { path: located.source, version };
      const where = spawnSync('which', ['codex'], { encoding: 'utf8' });
      const path = where.status === 0 ? (where.stdout || '').trim() || 'codex' : 'codex';
      return { path, version };
    } catch {
      return null;
    }
  },

  async spawn(prompt, ctx = {}) {
    const seatModel = requireSeatModel(ctx.environment, 'codex');
    const sandbox = normalizeSandboxTrust(ctx.environment?.sandbox);
    refuseWorkspaceTrust(sandbox, 'codex');
    // Passed through UNCOALESCED. `ctx.memoryLongTerm || ''` was here, and
    // `null || ''` is `''` — which routed the unreadable case straight into
    // the empty-memory branch and made the whole distinction unreachable from
    // the only two paths that build a real prompt. buildPrompt handles
    // undefined and '' as absence itself; it does not need a guard, it needs
    // the value.
    //
    // Of the two habits (TASK-545) a private Codex seat is taught row slicing
    // alone. claude.js adds parallel reads, whose cue names Claude's Agent tool;
    // Codex has agent tools of its own, under other names. A public seat answers
    // strangers rather than working board rows, so it is taught neither.
    // F445: a private seat on Linux resumes only a thread in its own Codex
    // home; one in the shared home (a run before F445) starts fresh, which the
    // prompt has to know.
    const ownPrivateHome = (ctx._platform || process.platform) === 'linux' && sandbox?.trust !== 'public'
      && !codexTrustedPerimeter(ctx.env || process.env) && ctx.hostUnconfined !== true
      ? privateCodexHomePath(ctx) : null;
    let sessionId = ctx.sessionId || null;
    if (ownPrivateHome && sessionId && !codexRolloutPath({ codexHome: ownPrivateHome, sessionId })) {
      process.stderr.write('[codex] this agent now keeps its own Codex home, so it starts a new thread; '
        + 'what it is meant to remember is in its Commonly memory.\n');
      sessionId = null;
    }
    const fullPrompt = buildPrompt(prompt, ctx.memoryLongTerm, {
      freshSession: !sessionId,
      workCues: sandbox?.trust === 'public' ? [] : [ROW_SLICING_CUE, BACKGROUND_PROCESS_CUE],
      // F118: a public seat reads its memory but is not offered a write.
      memoryReadOnly: sandbox?.trust === 'public' && ctx.ownerWoken !== true,
    });

    const workspacePath = sandbox?.trust === 'public'
      ? await refuseWorkspaceHoldingTurnDirs({ workspace: ctx.cwd, seat: 'public Codex agents' })
      : null;
    // Codex runs git in the workspace outside the seat's profile, so a
    // repository set up to run programs is refused before anything starts
    // (sandbox/workspace-git-config.js).
    if (workspacePath) {
      (ctx._refuseCodeRunningGitSetup || refuseCodeRunningGitSetup)(workspacePath, {
        seat: 'This public Codex agent', env: ctx.env || process.env,
      });
    }

    // Per-spawn temp dir for --output-last-message. Cleaned up in `finally`
    // so a crash in the middle of the spawn doesn't leak files in $TMPDIR.
    const dir = await mkdtemp(join(tmpdir(), 'commonly-codex-'));
    const outputFile = join(dir, 'last-message.txt');
    // Written into the per-spawn directory this adapter already creates and
    // removes: codex reads and writes inside it for --output-last-message, so a
    // child it spawns can reach a file there, which is the one property this
    // file has to have. Outside it the path is an unreadable promise.
    const credential = writeCredentialFile(ctx.runtimeToken, {
      agentName: ctx.agentName || 'agent',
      root: dir,
    });

    let providerProxy = null;
    const readyFiles = [];
    let credentialRelease = null;
    try {
      // A public seat can't run git from its shell on macOS: Homebrew's git is
      // outside the profile and /usr/bin/git is an xcrun shim that fails there.
      // So it reads its workspace's history through the read-only git tool a
      // Claude workspace seat has. Codex starts MCP servers outside the seat's
      // profile, so this one runs under a Seatbelt of its own
      // (confinedWorkspaceGitServer). An entry the environment declares under
      // the same name would run unconfined, so on a public seat it is replaced.
      const declaredMcp = ctx.environment?.mcp || [];
      let seatMcp = declaredMcp;
      if (workspacePath) {
        // The confined tool is opt-in (workspaceGitEnabled). A declared one is
        // dropped either way: Codex would run it outside the sandbox.
        const gitEnabled = workspaceGitEnabled();
        const declaresGit = declaredMcp.some((server) => server?.name === WORKSPACE_GIT_SERVER_NAME);
        if (declaresGit) {
          // eslint-disable-next-line no-console
          console.warn(`[codex] this public seat's environment declares ${WORKSPACE_GIT_SERVER_NAME}; `
            + (gitEnabled
              ? 'Codex would run it outside the sandbox, so the confined one replaces it'
              : 'Codex would run it outside the sandbox, so it is dropped'));
        }
        let workspaceGit = null;
        if (gitEnabled) {
          const stateDir = join(dir, 'git-tool');
          await mkdir(stateDir, { mode: 0o700 });
          workspaceGit = (ctx._workspaceGitServer || confinedWorkspaceGitServer)(workspacePath, {
            stateDir,
            platform: ctx._platform || process.platform,
          });
        }
        if (gitEnabled && !workspaceGit) {
          // eslint-disable-next-line no-console
          console.warn('[codex] the read-only git tool needs macOS and git on this machine, so this public seat has none');
        }
        seatMcp = [
          ...declaredMcp.filter((server) => server?.name !== WORKSPACE_GIT_SERVER_NAME),
          ...(workspaceGit ? [workspaceGit] : []),
        ];
      }
      // F460: a public seat's MCP servers name their ready files here; codex
      // starts them outside the seat's permission profile, beside the credential.
      const readyFileDir = sandbox?.trust === 'public' && credential ? join(dir, 'mcp-ready') : null;
      if (readyFileDir) await mkdir(readyFileDir, { recursive: true, mode: 0o700 });
      const mcp = buildMcpOverrideArgs(seatMcp, {
        runtimeToken: ctx.runtimeToken,
        instanceUrl: ctx.instanceUrl,
        credentialFile: credential?.path || null,
        readyFileDir,
        readyFiles,
        publicSeat: sandbox?.trust === 'public',
        ownerWoken: ctx.ownerWoken,
        commandResolution: { env: ctx.env || process.env, ...ctx._commandResolution },
      });
      if (mcp.unavailableMcp.length) throw publicMcpUnavailableError(mcp.unavailableMcp);
      // A derived record stores `trust: 'public'` and no mode (the block is
      // platform-independent; see cli/src/lib/default-environment.js). Codex's
      // mode only selects read vs write access — its permission profiles run on
      // both macOS and Linux — so the derived default is `workspace`, and an
      // explicit mode in the record still wins. Before this, a mode-less public
      // record threw `got unset` and no codex seat spawned at all.
      if (isLegacySandboxTrust(ctx.environment?.sandbox)) {
        // eslint-disable-next-line no-console
        console.warn(
          '[codex] sandbox.trust=internal is no longer accepted: it reads as '
          + 'confinement and engaged none. Resolving this seat as trust=public '
          + '(Wren 69585).',
        );
      }
      const publicSandboxMode = sandbox?.trust === 'public'
        ? sandbox?.mode ?? 'workspace'
        : null;
      // Checked before the public home is prepared, so a refused route changes nothing.
      // Only a seat that will forward the URL validates it: a ChatGPT host with an
      // OPENAI_BASE_URL set for some other tool keeps running, as it did before.
      const routeEnv = ctx.env || process.env;
      const route = publicSandboxMode !== null ? publicProviderRoute(routeEnv) : null;
      let modelBaseUrl = null;
      if (!route && publicSandboxMode !== null && String(routeEnv.OPENAI_BASE_URL || '').trim()) {
        const authKind = await codexAuthKind(operatorCodexHome(ctx), routeEnv);
        if (authKind === 'apikey') modelBaseUrl = publicModelRouteBaseUrl(routeEnv);
        else if (authKind === 'login') process.stderr.write(`[codex] ${CHATGPT_ROUTE_IGNORED}\n`);
      }
      const childEnv = { ...(ctx.env || process.env), ...mcp.forwardedEnv };
      // codex talks to the proxy alone, so none of the names it or its gateway
      // read stays in its environment, on the turn or on the version probe; the
      // turn gets the per-turn token instead. In upper case, as above: Windows
      // env names are case-insensitive, and this is a plain copy of them.
      if (route) {
        const routeNames = new Set([...CODEX_PROVIDER_KEY_ENVS, ...CODEX_OWN_AUTH_ENVS]);
        for (const name of Object.keys(childEnv)) {
          if (routeNames.has(name.toUpperCase())) delete childEnv[name];
        }
      }
      // F387: only a cloud-codex pod sets the perimeter env
      // (sandbox/codex-perimeter.js), and only the operator's own D245 opt-in
      // sets hostUnconfined. Every other private seat runs under the private
      // permission profile.
      const trustedContainerPerimeter = codexTrustedPerimeter(ctx.env || process.env);
      const operatorUnconfined = ctx.hostUnconfined === true;
      const privateProfile = publicSandboxMode === null && !trustedContainerPerimeter && !operatorUnconfined;
      // Before the public home is prepared, so a refused seat changes nothing.
      // A private profile uses the same permission keys, tested to the same bar.
      if (publicSandboxMode !== null || privateProfile) {
        const codexVersion = await readCodexVersion(ctx, childEnv);
        if (!meetsMinimumVersion(codexVersion, PUBLIC_CODEX_MIN_VERSION)) {
          throw publicCodexVersionError({
            found: codexVersion,
            required: PUBLIC_CODEX_MIN_VERSION,
            seat: publicSandboxMode !== null ? 'public seat' : 'private seat',
          });
        }
      }
      const publicCodexHome = publicSandboxMode !== null
        ? await preparePublicCodexHome(ctx, childEnv, { login: !route })
        : null;
      const privateCodexHome = privateProfile && ownPrivateHome
        ? await preparePrivateCodexHome(ctx, childEnv)
        : null;
      // The private shell's TMPDIR: inside this turn's folder, which `finally`
      // removes, and beside (not over) the token's folder.
      const privateShellTemp = privateProfile ? join(dir, 'shell-tmp') : null;
      if (privateShellTemp) await mkdir(privateShellTemp, { mode: 0o700 });
      if (route) {
        providerProxy = await (ctx._startProviderProxy || startProviderProxy)({
          provider: { baseURL: route.baseURL },
          keyMaterial: route.key,
          wire: 'openai-responses',
          adapterLabel: 'Codex',
        });
        childEnv[CODEX_PROVIDER_TOKEN_ENV] = providerProxy.token;
      }
      const args = buildArgs({
        sessionId,
        prompt: fullPrompt,
        outputFile,
        mcpFlags: mcp.flags,
        // Nothing is added for the git tool, which has a Seatbelt of its own:
        // admitting the git binary here would let the shell run git directly,
        // around the read-only server.
        mcpReadDirectories: mcp.mcpReadDirectories,
        publicSandboxMode,
        model: seatModel,
        effort: ctx.environment?.effort,
        commitAttributionEnv: ctx.commitAttributionEnv,
        codexHelperReadPaths: publicCodexHome?.helperReadPaths || [],
        modelBaseUrl,
        providerProxy,
        platform: ctx._platform || process.platform,
        workspacePath,
        trustedContainerPerimeter,
        operatorUnconfined,
        privateWorkspace: privateProfile && ctx.cwd ? pathResolve(ctx.cwd) : null,
        // Both roots: this process's, where every seat's per-turn folder
        // lives, and the one the shell would inherit.
        tempRoots: privateProfile ? [tmpdir(), childEnv.TMPDIR] : [],
        shellTempDir: privateShellTemp,
        // The home Codex runs with, and the HOME its `~` keys expand against.
        // Codex reads a relative CODEX_HOME from its own folder, the turn's.
        privateCodexHome: privateProfile
          ? privateCodexHome?.home || privateSourceCodexHome(ctx, childEnv)
          : null,
        privateHome: childEnv.HOME || homedir(),
        // Public seats' Codex homes (their sessions and logs): under the denied
        // ~/.commonly on macOS, outside it on Linux. With a home of its own, the
        // shared one it came from and every other private seat's are denied whole.
        privateOtherCodexHomes: privateProfile
          ? [...new Set([
            ...privatePublicHomesDeny(ctx),
            // By its real path too, when it is a link to another folder.
            ...(privateCodexHome
              ? [privateCodexHome.source, privateCodexHome.realSource, ...privateCodexHome.others]
              : []),
          ])]
          : [],
        privateCodexHomeLinks: privateCodexHome?.links || [],
        // F450: a seat with a home of its own keeps the person's login in
        // auth.json, linked to theirs. Codex's file store writes a refreshed
        // login through that link (open + truncate, codex-rs login
        // auth/storage.rs at rust-v0.164.0), so the person's file gets the new
        // tokens. Its keyring and auto stores save to the keyring under the
        // seat home's own path and delete the seat's auth.json, which would
        // leave the person's file holding the refresh token the refresh just
        // rotated. config.toml is linked in, so the seat would inherit those
        // modes; this keeps it on the file store.
        loginFileStore: Boolean(privateCodexHome),
      });
      // childEnv is derived from the process environment, so the bootstrap export has to be
      // taken back out: the declaration above moved our server onto the file,
      // and a value left here is a value codex's own children inherit. Kept only
      // when the substitution genuinely needed it (`forwardedEnv` names that
      // carve-out, and the warning above it is emitted for the same spawn).
      withholdRuntimeCredential(childEnv, {
        credentialFile: credential?.path || null,
        keepsValue: mcp.forwardedEnv[CREDENTIAL_KEY] !== undefined,
      });
      if (publicSandboxMode !== null && ctx.commitAttributionEnv) {
        Object.assign(childEnv, ctx.commitAttributionEnv);
      }
      if (publicSandboxMode !== null) {
        childEnv.CODEX_HOME = publicCodexHome.home;
        await writePublicCodexInstructions(childEnv.CODEX_HOME, ctx);
      }
      if (privateCodexHome) childEnv.CODEX_HOME = privateCodexHome.home;

      // The awaits above can outlast a supervisor stall window. Once it has
      // aborted, the attempt has already settled and a retry may be running,
      // so no process is created for this one. Checked synchronously before
      // runCodex, so the spawn itself cannot race the abort.
      if (ctx.signal?.aborted) {
        throw ctx.signal.reason || new Error('codex spawn cancelled before the process started');
      }
      // F460: on a public seat the credential goes once every MCP reader has it
      // (their ready files), or at the deadline. A delete that fails ends the turn.
      let releaseFailure = null;
      let child = null;
      const spawnImpl = (...spawnArgs) => {
        child = (ctx._spawnImpl || childSpawn)(...spawnArgs);
        return child;
      };
      if (readyFileDir) {
        credentialRelease = armCredentialRelease(credential, {
          readyFiles: readyFiles.map(({ path }) => path),
          label: 'public codex seat',
          warn: (text) => process.stderr.write(`[codex] ${text}\n`),
          onFailure: (err) => { releaseFailure = err; child?.kill?.('SIGKILL'); },
          ...ctx._credentialRelease,
        });
        // A delete that failed at arm time (every reader already ready) ends
        // the turn before Codex starts.
        if (credentialRelease.error) throw credentialRelease.error;
      }
      const ran = await runCodex({
        args,
        cwd: ctx.cwd,
        env: childEnv,
        timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
        // The values this spawn was handed, for the failure tail's exact-match
        // check: the seat credential and the provider key the route
        // authenticates with. Snapshot HERE — `withholdRuntimeCredential` above
        // already removed the token from the child copy, and after that there is
        // nothing left to compare a tail against.
        // The per-turn proxy token is one too: codex was handed it in place of the key.
        credentials: [...spawnCredentials(ctx, CODEX_PROVIDER_KEY_ENVS), route?.key, providerProxy?.token].filter(Boolean),
        spawnImpl, onSpawn: ctx.onSpawn, controls: controlsFromArguments(args.slice(args.indexOf('exec') + (args[args.indexOf('exec') + 1] === 'resume' ? 3 : 1), -1), { modelFlag: '--model', valueFlags: ['-c', '-o', '--permission-profile'], codex: true }), // test seam only — do not use in production
        ownGroup: wantsOwnProcessGroup(ctx),
        turnReap: ctx._turnReap,
        // A public seat keeps nothing a turn leaves running, whatever the turn
        // set (F201, as claude.js does for F197). `publicSandboxMode` is set
        // exactly when trust is `public`; workspace trust is refused above.
        confined: publicSandboxMode !== null,
        commandResolution: ctx._commandResolution, // test seam only
      }).catch((err) => { throw releaseFailure || err; });
      if (releaseFailure) throw releaseFailure;
      const { threadId, turnCompleted } = ran;

      let text = '';
      try {
        text = (await readFile(outputFile, 'utf8')).trim();
      } catch {
        // No file: a finished turn with no final message.
        // The run loop treats empty text as a silent turn and acknowledges it.
        text = '';
      }

      // A signal doesn't reach the exit code when codex runs through the npm
      // launcher: it re-raises SIGTERM or SIGHUP into its own handler and exits
      // 0. Resolving would read as a turn with nothing to say, and the messages
      // it held would never be answered. A final message counts as finished,
      // so a version that doesn't print turn.completed still posts its reply.
      if (!turnCompleted && !text) throw adapterFailure('codex', 'the turn stopped before it finished');

      // newSessionId precedence: thread_id from this turn (always emitted on
      // a new session, often re-emitted on resume) > the persisted id we
      // came in with > null. The wrapper persists whichever non-null value
      // we return so subsequent turns hit `codex exec resume <id>`.
      const newSessionId = threadId || sessionId || null;
      // F404: what the turn's last request was sent, from the rollout the child
      // wrote under its own CODEX_HOME. Null keeps resuming.
      const contextTokens = newSessionId
        ? (ctx._codexContextTokens || codexContextTokens)({ codexHome: codexHomeFor(childEnv), sessionId: newSessionId })
        : null;
      // D247: the reply receipt names the model and effort this spawn passed
      // (`--model`, `model_reasoning_effort`); codex's own stream does not
      // restate them.
      const effort = ctx.environment?.effort;
      const stats = { ...(seatModel ? { model: String(seatModel) } : {}),
        ...(typeof effort === 'string' && effort ? { effort } : {}) };
      return {
        text, newSessionId, contextTokens, ...(Object.keys(stats).length ? { stats } : {}),
      };
    } finally {
      credentialRelease?.stop();
      try { await providerProxy?.close(); } catch { /* ignore */ }
      try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  },
};
