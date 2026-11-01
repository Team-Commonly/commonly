import { claudeRuntimeInventory } from '../native-runtime-inventory.js';
import { observeSpawn, controlsFromArguments } from '../runtime-observation.js';
import {
  firstOutputWindowMs, killStallSurvivors, physicalPath, spawnStalledError, STALL_KILL_GRACE_MS, watchFirstOutput,
} from '../first-output-watchdog.js';
import {
  descendantsOf, killProcessTree, readProcessTable, spawnInOwnGroup, wantsOwnProcessGroup,
} from '@commonlyai/seats/process-group';
/**
 * claude adapter — wraps the local `claude` CLI as a Commonly agent.
 *
 * Contract: ADR-005 §Adapter pattern.
 *
 * Memory preamble: the adapter prepends the kernel's long-term memory context
 * on every turn. A fresh underlying session additionally receives the
 * read-first and durable-state-at-boundary cues (§Memory bridge).
 *
 * Environment (ADR-008 Phase 1): if ctx.environment is present, the adapter
 * symlinks declared Claude skills into `<cwd>/.claude/skills/`, writes an MCP
 * config file into a mode-0700 per-spawn temp directory outside the workspace
 * when `mcp` is declared, and wraps the argv with bwrap when
 * `sandbox.mode === 'bwrap'`. The spawn binary becomes `bwrap` in that case —
 * claude moves to the inner argv.
 * A public `workspace` / `read-only` sandbox maps to an outer deny-default
 * Seatbelt profile on macOS. Claude gets an isolated HOME, a credential-starved
 * child environment, and an explicit tool allow/deny policy; Claude and every
 * declared MCP child inherit the same kernel filesystem boundary.
 * When ctx.environment is absent, behaviour is identical to pre-ADR-008.
 *
 * Session continuity (IMPORTANT — the two claude flags are not interchangeable):
 *   - First turn (no persisted id): mint a UUID and pass `--session-id <uuid>`.
 *     claude treats `--session-id` as "CREATE a session with this exact UUID"
 *     and rejects with "Session ID ... is already in use" if the UUID was
 *     already used.
 *   - Subsequent turns (persisted id present): pass `--resume <uuid>` instead.
 *     `--resume` means "continue this existing session."
 *   The wrapper persists the UUID so the SAME id is used across turns — this
 *   adapter just picks the right flag for it.
 *
 * Purity (§Load-bearing invariants #1): input = argv + env + prompt;
 * output = text + session id. No direct network, no direct CAP calls.
 *
 * Test seam: `ctx._spawnImpl` is the sanctioned way for any adapter in this
 * codebase to swap `child_process.spawn` out for a mock. Unit tests pass a
 * fake that returns an EventEmitter; production never sets `_spawnImpl` so
 * the default `childSpawn` is used. Future adapters should follow the same
 * convention rather than inventing their own seam.
 *
 * Timeout caveat: we SIGTERM at `timeoutMs` and wait for `close`. If claude
 * ignores SIGTERM the promise never resolves — the run loop stalls silently.
 * SIGKILL escalation is a post-v1 concern (ADR-005 §Spawning semantics).
 */

import { requireSeatModel, seatModelRequired } from './seat-model.js';
import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { accessSync, constants, realpathSync } from 'fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import {
  delimiter, dirname, isAbsolute, join,
} from 'path';
import { fileURLToPath } from 'url';

import {
  isLegacySandboxTrust,
  mountSkills,
  normalizeSandboxTrust,
} from '../environment.js';
import { detectBwrap, wrapArgvWithBwrap } from '../sandbox/bwrap.js';
import { PUBLIC_SANDBOX_MODES, resolvePublicSandboxMode } from '../sandbox/mode.js';
import {
  publicClaudeStateRoot,
  wrapArgvWithSeatbelt,
} from '../sandbox/seatbelt.js';
import { CREDENTIAL_FILE_VAR, CREDENTIAL_KEY, writeCredentialFile } from '../credential-file.js';
import { supportedGitHooks } from '../commit-attribution.js';
import { deliverSeatCredential, withholdRuntimeCredential } from '../mcp-credential-delivery.js';
import {
  prepareMcpSpawn, PUBLIC_MCP_UNAVAILABLE_CODE, publicMcpUnavailableError, selectedMcpVersionDir,
} from '../mcp-home.js';
import { buildMemoryPreamble, ROW_SLICING_CUE } from '../memory-bridge.js';
import { claudeConfigDirFor, claudeContextTokens, claudeTranscriptPath } from '../session-recycle.js';
import { skillsAsText } from '../skill-prompt.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';
import { PUBLIC_WITHHELD_TOOLS } from '../public-withheld-tools.js';
import { isShippedCommonlyMcpCommand } from '../declared-mcp-guard.js';
import { isAnswerableToolError, PUBLIC_MCP_NOT_READY_CODE, PUBLIC_TOOL_FAILED_CODE } from '../public-tool-error.js';

// See codex.js for the rationale on bumping the default + env override.
// Keeping both adapters in lockstep so any wrapper agent runtime has the
// same timeout posture regardless of which CLI is underneath.
const DEFAULT_TIMEOUT_MS = (() => {
  const fallback = 15 * 60 * 1000;
  const raw = process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS;
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
})();

const buildPrompt = buildMemoryPreamble;

// The working habits a private claude seat is taught on a fresh session
// (TASK-545). Parallel reads live here because only this CLI has a subagent
// tool; codex is passed row slicing alone. A public seat is passed neither: its
// argv allows Read and the MCP under dontAsk, so it has no subagent to spawn,
// and it answers strangers rather than working board rows.
const PARALLEL_READS_CUE = 'Parallel reads: when a row needs several files or sources read, '
  + 'use the Agent tool. Spawn read-only subagents in parallel, brief each one with the files '
  + 'to read and the question to answer, and keep only their conclusions.';
const WORK_CUES = [PARALLEL_READS_CUE, ROW_SLICING_CUE];
const RUNTIME_CREDENTIAL_PLACEHOLDER = '${COMMONLY_AGENT_TOKEN}';

const QUOTE_SHELL_ARGUMENT = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const HEADER_TOKEN_HELPER_SOURCE = `import { readFileSync } from 'node:fs';

const credentialFile = process.env.${CREDENTIAL_FILE_VAR};
if (!credentialFile) throw new Error('missing ${CREDENTIAL_FILE_VAR}');
const token = readFileSync(credentialFile, 'utf8').trim();
if (!token) throw new Error('empty ${CREDENTIAL_FILE_VAR}');
const templates = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const headers = Object.fromEntries(
  Object.entries(templates).map(([name, parts]) => [name, parts.join(token)]),
);
process.stdout.write(JSON.stringify(headers) + '\\n');
`;

const PUBLIC_DENIED_TOOLS = [
  'WebSearch',
  'WebFetch',
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Task',
];
// TASK-294: a workspace seat is confined as a public one is, except that its
// folder is the person's project, which the jail holds read-only unless the
// seat was granted write, and whose .git it holds read-only either way.
const isConfinedTrust = (trust) => trust === 'public' || trust === 'workspace';
// What each `sandbox.allow` grant moves out of the denies. `web` grants
// WebFetch alone: WebSearch, NotebookEdit and Task stay denied at every tier.
// Bash and Write land wherever the jail lets them, so the jail, not this list,
// bounds a write.
const WORKSPACE_ALLOW_TOOLS = {
  write: ['Edit', 'Write', 'Bash'],
  web: ['WebFetch'],
};
// The grants a seat's environment carries. They widen the workspace tier
// only, so any other trust gets none, whatever its record says.
const workspaceGrants = (sandbox) => (
  sandbox?.trust === 'workspace' && Array.isArray(sandbox.allow) ? sandbox.allow : []
);
// A workspace seat reads its project's history through one read-only git tool
// (git-readonly-server.js). The server runs inside the jail, so the jail must
// admit its code (cli/src/lib, plus package.json for the module type) and the
// git binary it runs.
const WORKSPACE_GIT_SERVER = fileURLToPath(new URL('../git-readonly-server.js', import.meta.url));
const WORKSPACE_GIT_PACKAGE_JSON = fileURLToPath(new URL('../../../package.json', import.meta.url));
// macOS's /usr/bin/git is an xcrun shim, and it fails inside Seatbelt ("No
// developer tools were found"). So the jail gets the binary git itself runs:
// `git --exec-path`, resolved here on the host, holds a `git` that links to it.
const resolveRealGit = () => {
  const result = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 5000 });
  const execDir = result?.status === 0 ? String(result.stdout || '').trim() : '';
  if (!execDir) return null;
  try {
    return realpathSync(join(execDir, 'git'));
  } catch {
    return null;
  }
};
const withWorkspaceGit = (ctx) => {
  if (ctx.environment?.sandbox?.trust !== 'workspace' || !ctx.cwd) return ctx;
  const git = resolveRealGit();
  if (!git) {
    // eslint-disable-next-line no-console
    console.warn('[claude] git was not found on this machine, so this workspace seat has no git tool');
    return ctx;
  }
  const server = {
    name: 'workspace_git',
    transport: 'stdio',
    command: [process.execPath, WORKSPACE_GIT_SERVER, '--root', ctx.cwd, '--git', git],
  };
  return {
    ...ctx,
    environment: { ...ctx.environment, mcp: [...(ctx.environment.mcp || []), server] },
    workspaceGit: {
      executable: git,
      readDirectories: [dirname(WORKSPACE_GIT_SERVER)],
      readPaths: [WORKSPACE_GIT_PACKAGE_JSON],
    },
  };
};
const PUBLIC_SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;

const statOrNull = async (path) => {
  try {
    return await lstat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
};

// The non-secret account metadata Claude needs from ~/.claude.json to find its
// login, and nothing else from that file.
const claudeAuthMetadata = async () => {
  const operatorConfigPath = join(homedir(), '.claude.json');
  const sourceStat = await statOrNull(operatorConfigPath);
  let source = {};
  if (sourceStat) {
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`refusing non-regular operator Claude config: ${operatorConfigPath}`);
    }
    try {
      source = JSON.parse(await readFile(operatorConfigPath, 'utf8'));
    } catch (err) {
      throw new Error(`failed to read operator Claude auth metadata: ${err.message}`);
    }
  }
  const sanitized = { hasCompletedOnboarding: true };
  for (const key of ['installMethod', 'userID', 'machineID', 'oauthAccount']) {
    if (source[key] !== undefined) sanitized[key] = source[key];
  }
  return sanitized;
};

// Claude's macOS OAuth credential lives in Keychain, but Claude also needs a
// small amount of non-secret account metadata from ~/.claude.json to locate
// it. Never bind or copy the operator's full file: it contains project paths,
// MCP configuration, usage history, and other host-private metadata. Public
// wrappers get a per-identity 0700 HOME carrying only this whitelist.
const preparePublicClaudeState = async (ctx) => {
  const identity = ctx.agentName || ctx.cwd || 'anonymous';
  const identityHash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  const statePath = ctx._publicClaudeState
    || publicClaudeStateRoot(identityHash);
  const tmpPath = join(statePath, 'tmp');
  const configPath = join(statePath, '.claude.json');
  const stateLibrary = join(statePath, 'Library');
  const stateKeychains = join(stateLibrary, 'Keychains');
  const operatorKeychains = join(homedir(), 'Library', 'Keychains');

  await mkdir(tmpPath, { recursive: true, mode: 0o700 });
  await mkdir(stateLibrary, { recursive: true, mode: 0o700 });
  await chmod(statePath, 0o700);
  await chmod(tmpPath, 0o700);
  await chmod(stateLibrary, 0o700);

  // `/usr/bin/security` resolves the default login keychain relative to HOME.
  // Keep HOME isolated while pointing that one standard location at the
  // operator's encrypted keychain database. Seatbelt admits the keychain
  // directory read-only; no bearer credential is copied into agent state.
  const keychainLink = await statOrNull(stateKeychains);
  if (keychainLink && !keychainLink.isSymbolicLink()) {
    throw new Error(`refusing to replace non-symlink Claude keychain path: ${stateKeychains}`);
  }
  if (keychainLink) {
    const target = await readlink(stateKeychains);
    if (target !== operatorKeychains) {
      await unlink(stateKeychains);
      await symlink(operatorKeychains, stateKeychains);
    }
  } else {
    await symlink(operatorKeychains, stateKeychains);
  }

  await writeFile(
    configPath,
    `${JSON.stringify(await claudeAuthMetadata(), null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(configPath, 0o600);
  return { statePath, tmpPath, configPath };
};

// Writes a 0600 file into a directory the confined child can also write. The
// directory must still be a real directory, and the file is written beside the
// target and renamed over it, so a symlink the child left at either name is
// replaced, never followed into another of the person's files.
const replacePrivateFile = async (dir, name, content) => {
  const dirStat = await statOrNull(dir);
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`refusing to write Claude state into a non-directory: ${dir}`);
  }
  const target = join(dir, name);
  const staged = join(dir, `.${name}.${randomUUID()}.tmp`);
  await writeFile(staged, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await chmod(staged, 0o600);
    await rename(staged, target);
  } catch (err) {
    await rm(staged, { force: true });
    throw err;
  }
  return target;
};

// A workspace seat on Linux runs under bwrap, which has no keychain. Claude
// Code on Linux keeps its login in <config dir>/.credentials.json, so the
// seat's own state dir gets a copy of the person's, taken fresh each spawn:
// their own credential on their own machine, the exposure the macOS keychain
// arm already has. Only the copy is inside the jail. Nothing is written back:
// the jail can write its copy, and a write-back would let it replace the
// person's login with one of its choosing. A missing login removes the copy,
// so a person who logged out is not still signed in here.
const claudeLoginSource = (env) => join(
  env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  '.credentials.json',
);

// Opened once, without following a symlink, and checked on the open handle,
// so the file read is the file checked (a FIFO cannot hold the open either).
const carryClaudeLogin = async (env, configDir) => {
  const source = claudeLoginSource(env);
  const refuse = () => new Error(`refusing a Claude login that is not a regular file: ${source}`);
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      await rm(join(configDir, '.credentials.json'), { force: true });
      return null;
    }
    if (err?.code === 'ELOOP') throw refuse();
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) throw refuse();
    return replacePrivateFile(configDir, '.credentials.json', await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
};

// State for a workspace seat under bwrap: the same per-seat folder the macOS
// path uses, outside the person's project, with the auth metadata whitelist
// and the login copy. The jail binds this folder writable and makes it HOME,
// so transcripts land here rather than in the project.
const prepareWorkspaceBwrapClaudeState = async (ctx) => {
  const identity = ctx.agentName || ctx.cwd || 'anonymous';
  const identityHash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  const statePath = ctx._publicClaudeState || publicClaudeStateRoot(identityHash);
  const tmpPath = join(statePath, 'tmp');
  const configDir = join(statePath, '.claude');
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  await chmod(statePath, 0o700);
  for (const dir of [tmpPath, configDir]) {
    const existing = await statOrNull(dir);
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
      throw new Error(`refusing Claude state path that is not a directory: ${dir}`);
    }
    if (!existing) await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
  }

  const configPath = await replacePrivateFile(
    statePath, '.claude.json', `${JSON.stringify(await claudeAuthMetadata(), null, 2)}\n`,
  );
  const loginPath = await carryClaudeLogin(ctx.env, configDir);
  return { statePath, tmpPath, configPath, loginPath };
};

const buildClaudeEnv = (input, state, expansionEnv = {}, credentialFile = null, publicSeat = false) => {
  const source = input || process.env;
  const output = state || publicSeat ? {} : { ...source };
  if (state || publicSeat) {
    for (const [key, value] of Object.entries(source)) {
      if (PUBLIC_SAFE_ENV.test(key)) output[key] = value;
    }
  }
  if (state) {
    output.HOME = state.statePath;
    output.TMPDIR = state.tmpPath;
    // Claude keeps its temp root at /private/tmp/claude-<uid> unless told
    // otherwise; the seat's Seatbelt profile admits only its own tmp.
    output.CLAUDE_CODE_TMPDIR = state.tmpPath;
    output.XDG_CACHE_HOME = join(state.statePath, '.cache');
    output.XDG_CONFIG_HOME = join(state.statePath, '.config');
    output.XDG_DATA_HOME = join(state.statePath, '.local', 'share');
  }
  Object.assign(output, expansionEnv);
  // `source` is usually the process environment, which is where the documented
  // bootstrap export lives — so the value has to be taken out here rather than
  // merely left out of the declaration rewrite. It survives only when THIS
  // spawn's declaration still references it (claude substitutes args, url and
  // headers literally, and `buildMcpExpansionEnv` reports that by carrying the
  // key); the file path goes in either way so a hook child can name it.
  return withholdRuntimeCredential(output, {
    credentialFile,
    keepsValue: expansionEnv[CREDENTIAL_KEY] !== undefined,
  });
};

const absoluteToolDeny = (path) => `Read(/${path}/**)`;

// The tools that read or write the seat's agent-wide memory.
const MEMORY_TOOLS = Object.freeze(['commonly_read_agent_memory', 'commonly_write_agent_memory', 'commonly_save_my_memory']);

const buildPublicClaudePolicyArgs = (mcpToolPatterns, { trust, allow = [], memoryWithheld = false } = {}) => {
  const home = homedir();
  // `allow` is already narrowed to a workspace seat's grants (workspaceGrants).
  const granted = allow.flatMap((grant) => WORKSPACE_ALLOW_TOOLS[grant] || []);
  const deniedReads = [
    absoluteToolDeny(join(home, '.commonly')),
    absoluteToolDeny(join(home, '.claude')),
    absoluteToolDeny(join(home, '.codex')),
    absoluteToolDeny(join(home, '.ssh')),
    absoluteToolDeny(join(home, '.aws')),
    absoluteToolDeny(join(home, '.config')),
    'Read(//private/tmp/**)',
    'Read(./.commonly/**)',
    'Read(./.codex/**)',
    'Read(./.env)',
  ];
  // A workspace seat reads a real project, so every .env variant at any depth,
  // and what a .env directory holds, stays out of reach (the jail holds the
  // same line). .git is denied too: its config can carry a remote URL with a
  // token in it, and history comes through the read-only git tool, which runs
  // in its own process. And the seat cannot install itself into a room partway
  // through a turn: the per-turn check confirmed its pods private before the
  // spawn.
  const workspaceDenies = trust === 'workspace'
    ? [
      'Read(./.env.*)', 'Read(./**/.env)', 'Read(./**/.env.*)',
      'Read(./.env/**)', 'Read(./**/.env/**)', 'Read(./**/.env.*/**)',
      'Read(./.git/**)', 'Read(./**/.git/**)',
      ...mcpToolPatterns.map((pattern) => pattern.replace(/\*$/, 'commonly_self_install_into_pod')),
    ]
    : [];
  // A workspace seat's turn that runs public gets no memory in its prompt
  // (agent.js), and no tool that would read or write it either.
  const memoryDenies = memoryWithheld
    ? MEMORY_TOOLS.flatMap((tool) => mcpToolPatterns.map((pattern) => pattern.replace(/\*$/, tool)))
    : [];
  // Nor, on any confined trust, the tools no public seat is offered
  // (public-withheld-tools.js).
  const withheldDenies = PUBLIC_WITHHELD_TOOLS
    .flatMap((tool) => mcpToolPatterns.map((pattern) => pattern.replace(/\*$/, tool)));
  return [
    // HOME points at an isolated, sanitized state directory. Ignore settings
    // from user/project/local sources and disable slash-command extensions;
    // unlike --safe-mode, this preserves the explicit --mcp-config capability.
    '--setting-sources', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--no-chrome',
    '--permission-mode', 'dontAsk',
    '--allowedTools', 'Read(./**)', ...granted, ...mcpToolPatterns,
    '--disallowedTools', ...PUBLIC_DENIED_TOOLS.filter((tool) => !granted.includes(tool)),
    ...deniedReads, ...workspaceDenies, ...memoryDenies, ...withheldDenies,
  ];
};

// A public seat's skills, as appended system-prompt text.
//
// `--disable-slash-commands` above is Claude's switch for ALL skills, and
// `--setting-sources ''` drops the project source the mounted copies live in.
// So the skills this adapter mounts into <cwd>/.claude/skills never load in a
// public seat: measured 2026-10-19 on a Bring your own page seat, which
// answered "I don't see a skill named commonly, or any skills list or Skill
// tool"; the same workspace with `--setting-sources project` found it. Every
// self-serve seat is public (COMMONLY_DEFAULT_SANDBOX), so every outsider's
// Claude ran without the house rules buildDefaultEnvironment mounts for it.
// Re-enabling skills would also hand a public seat the built-in ones
// (computer-use, the browser skills), so the flags stay and the declared text
// is delivered as prompt instead. Inline rather than a file: nothing new has to
// be admitted through Seatbelt. Linux caps one argv string at 128 KiB, so the
// total is capped well under it.
const PUBLIC_SKILL_PROMPT_MAX_BYTES = 96 * 1024;
const publicSkillPromptArgs = async (skillSources) => {
  const included = [];
  const text = await skillsAsText(skillSources, {
    maxBytes: PUBLIC_SKILL_PROMPT_MAX_BYTES,
    label: 'claude',
    onIncluded: (source) => included.push(source),
  });
  return { args: text ? ['--append-system-prompt', text] : [], included };
};

// `ownGroup` is set only under the run supervisor, which kills the child's
// whole group; unsupervised, the spawn options are exactly what they were.
// Stream-json so each model event is a sign of life for the watchdog. The
// partial messages put thinking deltas on the stream too, so a long think is
// visible while it runs. A hung provider writes only `system` retry events,
// and the watchdog does not count those.
const STREAM_ARGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

const parseEvent = (line) => {
  try {
    const event = JSON.parse(line);
    return event && typeof event === 'object' ? event : null;
  } catch {
    return null;
  }
};

// The reply is the `result` event's text. A turn that reaches no result event
// (killed mid-stream, exit 0) gets the text of its assistant events, never the
// raw NDJSON. Output with no JSON lines at all is plain text and returned as it
// arrived. A result flagged `is_error` is a failed turn, whatever its exit code,
// so it is raised here, outside the parse guard, and never returned as a reply.
export const claudeResultText = (stdout, { credentials = [] } = {}) => {
  const text = String(stdout || '');
  const events = text.split('\n').map(parseEvent);
  if (!events.some(Boolean)) return text.trim();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type !== 'result') continue;
    const reply = String(events[i].result ?? '').trim();
    if (events[i].is_error === true) throw adapterFailure('claude', reply, { credentials });
    return reply;
  }
  return events
    .filter((event) => event?.type === 'assistant')
    .flatMap((event) => event.message?.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
};

// TASK-256: what a public seat's own stream says about its Commonly MCP server.
// Claude Code reports each server's state in the init event (`connected` or
// `failed`), and a failed tool call as a `tool_result` with `is_error: true`
// whose content is the server's text, the shipped MCP's `{status, body,
// message}` JSON (both measured on Claude Code 2.1.314; `-p` waits for a slow
// server, so init reports it connected rather than pending). Ready is a positive
// witness: `connected` in init, or `pending` followed by a Commonly call that
// returned, since a server may finish starting during the turn. A stream with no
// init event, or with a Commonly server in any other state, never showed the
// server working, so the turn is withheld. A failed
// Commonly call withholds it unless `isAnswerableToolError` names an answer the
// person can be given (the predicate the OpenCode adapter uses). Only servers
// that run the shipped Commonly MCP count. Returns the failure, or null.
const toolResultText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('');
};

export const claudePublicMcpWitness = (stdout, mcpServers) => {
  const names = (Array.isArray(mcpServers) ? mcpServers : [])
    .filter((server) => server?.name && isShippedCommonlyMcpCommand(server.command))
    .map((server) => String(server.name));
  if (!names.length) return null;
  const events = String(stdout || '').split('\n').map(parseEvent).filter(Boolean);
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const servers = Array.isArray(init?.mcp_servers) ? init.mcp_servers : [];
  const toolNames = new Map();
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    for (const block of event.message?.content || []) {
      if (block?.type === 'tool_use' && block.id) toolNames.set(block.id, String(block.name || ''));
    }
  }
  const results = events
    .filter((event) => event.type === 'user' && Array.isArray(event.message?.content))
    .flatMap((event) => event.message.content)
    .filter((block) => block?.type === 'tool_result')
    .map((block) => ({ block, tool: toolNames.get(block.tool_use_id) || '' }));
  // Init names a server as declared; tool names carry it with every character
  // outside [A-Za-z0-9_-] turned to `_` (`commonly.me` → `mcp__commonly_me__`,
  // measured on 2.1.314).
  const prefixOf = (name) => `mcp__${name.replace(/[^A-Za-z0-9_-]/g, '_')}__`;
  for (const name of names) {
    const status = servers.find((server) => server?.name === name)?.status;
    const returned = status === 'pending'
      && results.some(({ block, tool }) => block.is_error !== true && tool.startsWith(prefixOf(name)));
    if (status !== 'connected' && !returned) {
      return { code: PUBLIC_MCP_NOT_READY_CODE, tool: name, error: init ? `status ${status || 'absent'}` : 'no init event' };
    }
  }
  const prefixes = names.map(prefixOf);
  for (const { block, tool } of results) {
    if (block.is_error !== true || !prefixes.some((prefix) => tool.startsWith(prefix))) continue;
    const error = toolResultText(block.content);
    if (!isAnswerableToolError(error)) return { code: PUBLIC_TOOL_FAILED_CODE, tool, error };
  }
  return null;
};

const publicWitnessError = ({ code, tool, error }) => {
  const reason = String(error).replace(/\s+/g, ' ').slice(0, 160) || '(empty error)';
  const what = code === PUBLIC_MCP_NOT_READY_CODE
    ? `Commonly MCP server ${tool} was not shown connected`
    : `Commonly tool ${tool} failed in a way the model must not narrate`;
  const failure = new Error(
    `public seat withheld this turn's reply: ${what} (${reason}), so nothing was posted and the event stays unacked for retry`,
  );
  failure.code = code;
  return failure;
};

// The reply a turn posts. A public seat's turn is witnessed first (TASK-256).
const turnReply = (stdout, { credentials, publicMcp }) => {
  if (publicMcp) {
    const failure = claudePublicMcpWitness(stdout, publicMcp);
    if (failure) throw publicWitnessError(failure);
  }
  return claudeResultText(stdout, { credentials });
};

// The failure tail for a non-zero exit. Stream events are mostly system init
// and status lines, which would push the terminal error past the 2000-char cut,
// so keep the result text, or the lines that are not system or stream events.
export const claudeFailureTail = (stdout) => {
  const text = String(stdout || '');
  const lines = text.split('\n');
  const events = lines.map(parseEvent);
  if (!events.some(Boolean)) return text.trim();
  const result = [...events].reverse().find((event) => event?.type === 'result');
  if (String(result?.result ?? '').trim()) return String(result.result).trim();
  return lines
    .filter((_, i) => !['system', 'stream_event'].includes(events[i]?.type))
    .join('\n')
    .trim();
};

const runClaude = ({
  cmd, args, cwd, env, timeoutMs, credentials = [], spawnImpl = childSpawn, onSpawn, controls = {}, ownGroup = false,
  transcriptPath = null, firstOutputMs = firstOutputWindowMs(), lockProbe, stallKillGraceMs = STALL_KILL_GRACE_MS,
  processTable = readProcessTable, survivorIo, modelStream = true,
}) => new Promise((resolve, reject) => {
  const proc = spawnInOwnGroup(spawnImpl, cmd, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }, { ownGroup });
  observeSpawn(proc, onSpawn, controls);
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
  }, timeoutMs);
  // A turn that never starts is killed long before the run timeout.
  let stalled = null;
  let stallKill = null;
  let stallSnapshot = [];
  // SIGKILL snapshotted descendants that are still alive. Safe to repeat. It
  // runs when the spawn exits, at the grace deadline and on close: a survivor
  // still holding the spawn's stdout or stderr keeps close from ever firing,
  // and once the spawn is reaped killProcessTree can no longer reach it.
  const sweepStallSurvivors = () => {
    if (stalled) killStallSurvivors(stallSnapshot, survivorIo);
  };
  const treeIo = (table) => ({ table, ...(survivorIo?.read ? { read: survivorIo.read } : {}) });
  const watchdog = watchFirstOutput({
    proc,
    windowMs: firstOutputMs,
    transcriptPath,
    modelStream,
    lockProbe,
    onStall: (reason) => {
      stalled = spawnStalledError({ label: 'claude', windowMs: firstOutputMs, reason });
      // Snapshot the descendants first: once the spawn exits they are
      // reparented and can no longer be found from it.
      const table = Number.isInteger(proc.pid) ? processTable() : null;
      if (table) stallSnapshot = descendantsOf(table, proc.pid);
      killProcessTree(proc, 'SIGTERM', treeIo(() => table));
      // A stopped process holds a SIGTERM it handles (claude does) until it is
      // continued, so a turn frozen with SIGSTOP sat out the whole grace below:
      // 191 s on a 180 s window (rivet, 2026-11-01). SIGCONT lets it act on the
      // SIGTERM now. A process that is not stopped is unaffected unless it
      // handles SIGCONT (a job-control shell does); the SIGKILL below still
      // lands at the grace either way.
      killProcessTree(proc, 'SIGCONT', treeIo(() => table));
      // A process parked in a system call may not act on SIGTERM. SIGKILL the
      // child, its group when it leads one, and its descendants.
      stallKill = setTimeout(() => {
        killProcessTree(proc, 'SIGKILL', treeIo(processTable));
        sweepStallSurvivors();
        // A pipe holder the snapshot missed (ps failed, or it was reparented
        // before the stall) would still keep close from firing. Dropping our
        // ends of the pipes bounds every stalled turn at window plus grace.
        proc.stdout?.destroy?.();
        proc.stderr?.destroy?.();
      }, stallKillGraceMs);
      stallKill.unref?.();
    },
  });
  proc.on('exit', sweepStallSurvivors);

  proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.on('error', (err) => {
    clearTimeout(timer);
    clearTimeout(stallKill);
    watchdog.stop();
    reject(err);
  });
  proc.on('close', (code) => {
    clearTimeout(timer);
    clearTimeout(stallKill);
    watchdog.stop();
    if (stalled) {
      sweepStallSurvivors();
      return reject(stalled);
    }
    if (timedOut) return reject(new Error(`claude timed out after ${timeoutMs}ms`));
    if (code !== 0) {
      // Report stdout too, not just stderr. In `-p` mode claude writes terminal
      // conditions (usage limits especially) to stdout and exits non-zero with
      // stderr empty — 361 consecutive failures on 2026-08-03 carried no reason
      // at all because of this. It is not only a diagnosability problem: the
      // circuit breaker classifies from the error message, so a blank message
      // downgrades a hard quota failure to RUNTIME and its shortest backoff.
      //
      // TASK-103: the tail goes through the same reader pi's refusal log uses.
      // A non-JSON tail (which this normally is — the usage-limit line above is
      // prose) is kept whole and only exact-match redacted; a JSON body is
      // reduced to one named field. The status, when the tail names one, is
      // attached as `error.status` so a refusal classifies by field rather than
      // by regex.
      const detail = [stderr.trim(), claudeFailureTail(stdout)].filter(Boolean).join(' | ');
      return reject(adapterFailure('claude', detail, {
        credentials,
        exitCode: code,
        limit: 2000,
      }));
    }
    resolve(stdout);
  });
});

// ── MCP config write — claude consumes this via --mcp-config <path> ─────────

// Keep Commonly placeholders in the MCP JSON and expose their values only in
// Claude's per-spawn environment. Claude Code natively expands ${VAR} in MCP
// command/args/env/url/header fields. Token-bearing HTTP headers are routed
// through headersHelper below, because a literal expansion would put the
// credential in Claude's environment and every MCP child's environment.
//
// Recognised placeholders:
//   ${COMMONLY_TOKEN_FILE}    — the PATH of this spawn's credential file
//   ${COMMONLY_API_URL}       — the instance URL the agent is attached to
//   ${COMMONLY_INSTANCE_URL}  — alias for COMMONLY_API_URL (clearer in context)
//
// The credential itself is deliberately NOT among these values (TASK-083). It
// used to be, and that put the bearer token in claude's environment, where every
// MCP child and every hook inherited it — measured on a live seat: the pi seat's
// MCP child carried COMMONLY_AGENT_TOKEN and COMMONLY_LITELLM_KEY. What the
// child gets instead is a path to a 0600 file that only this spawn can name,
// written into the SAME per-spawn directory claude is already handed for
// --mcp-config. That directory is not a coincidence: it is the one path outside
// the workspace that the Seatbelt profile admits (sandbox/seatbelt.js admits
// `subpath(mcpConfigDir)` and nothing under ~/.commonly but the seat's own
// statePath), so a credential file placed anywhere else is unreadable by the
// very child it is written for.
//
// Only values actually referenced by this MCP declaration are added to the
// child environment. Unknown placeholders remain in JSON so Claude's parser
// fails clearly instead of receiving a silent empty string.
const buildMcpExpansionEnv = (mcpConfig, ctx) => {
  const serialized = JSON.stringify(mcpConfig);
  const values = {
    [CREDENTIAL_FILE_VAR]: ctx.credentialFile || '',
    COMMONLY_API_URL: ctx.instanceUrl || '',
    COMMONLY_INSTANCE_URL: ctx.instanceUrl || '',
    // Whether THIS one is exposed is decided by the loop below, not here: it is
    // added only when the value is non-empty AND the declaration still references
    // it — and `serialized` is the config AFTER the credential rewrite, which is
    // what moves the default declaration off this value and onto the file. A
    // reference that cannot use the file channel (args, url, unsupported or
    // non-HTTP headers, or a string that merely contains the placeholder) keeps
    // the value for that spawn. createMcpConfig warns when this carve-out applies.
    COMMONLY_AGENT_TOKEN: ctx.runtimeToken || '',
  };
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    const referenced = serialized.includes(`\${${key}}`)
      || (key === CREDENTIAL_FILE_VAR && ctx.headersHelperUsesCredentialFile === true);
    if (value && referenced) output[key] = value;
  }
  return output;
};

const isHttpTransport = (server) => {
  const transport = String(server?.transport || server?.type || '').trim().toLowerCase();
  return transport === 'http' || transport === 'streamable-http';
};

const getTokenHeaderTemplates = (server) => {
  if (!isHttpTransport(server) || !server.headers || typeof server.headers !== 'object') return null;
  const templates = Object.fromEntries(
    Object.entries(server.headers)
      .filter(([, value]) => typeof value === 'string' && value.includes(RUNTIME_CREDENTIAL_PLACEHOLDER))
      .map(([name, value]) => [name, value.split(RUNTIME_CREDENTIAL_PLACEHOLDER)]),
  );
  return Object.keys(templates).length > 0 ? templates : null;
};

const writePrivateFile = async (path, contents) => {
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
};

// Claude's headersHelper is invoked when an HTTP connection is established and
// again after an authentication retry. Keep the token out of its config and
// environment: the helper reads the current per-spawn file on every invocation.
const createTokenHeaderHelpers = async (mcpServers, dir) => {
  const servers = mcpServers
    .map((server, index) => ({ server, index, templates: getTokenHeaderTemplates(server) }))
    .filter((item) => item.templates);
  if (servers.length === 0) return new Map();

  const scriptPath = join(dir, 'headers-helper.mjs');
  await writePrivateFile(scriptPath, HEADER_TOKEN_HELPER_SOURCE);
  const helpers = new Map();
  for (const { server, index, templates } of servers) {
    const templatesPath = join(dir, `headers-${index}.json`);
    await writePrivateFile(templatesPath, JSON.stringify(templates));
    helpers.set(server.name, {
      command: [
        QUOTE_SHELL_ARGUMENT(process.execPath),
        QUOTE_SHELL_ARGUMENT(scriptPath),
        QUOTE_SHELL_ARGUMENT(templatesPath),
      ].join(' '),
      headerNames: Object.keys(templates),
    });
  }
  return helpers;
};

const buildMcpConfig = (mcpServers, ctx = {}) => {
  // Shape: `{ mcpServers: { <name>: { ... } } }` — the standard MCP client
  // config, which claude's `--mcp-config` reads directly.
  const mcpServersMap = {};
  for (const server of mcpServers) {
    // TASK-174: the command this seat will EXECUTE, not the one it declared —
    // `node <home>/<version>/node_modules/@commonlyai/mcp/<bin>` when the seat's
    // MCP home has a warmed build, and otherwise the unchanged declaration. The
    // credential channel below is decided on that same command, so the two can
    // never disagree about which release is running.
    const spawnCommand = server.command
      ? prepareMcpSpawn(server.command, {
        apiUrl: ctx.instanceUrl, publicSeat: ctx.publicSeat,
      })
      : null;
    if (server.command && !spawnCommand) {
      ctx.unavailableMcp?.push(server.name);
      continue;
    }
    const executed = spawnCommand ? { ...server, command: spawnCommand } : server;
    const entry = { type: server.transport || 'stdio' };
    if (server.url) entry.url = server.url;
    if (spawnCommand) {
      const [command, ...args] = spawnCommand;
      entry.command = command;
      if (args.length) entry.args = args;
    }
    // A declared credential is rewritten to the file channel here, in the
    // config claude actually reads, so the value never has to exist in the
    // runtime's environment at all (TASK-083).
    if (server.env) {
      entry.env = deliverSeatCredential(executed, {
        credentialFile: ctx.credentialFile,
        label: 'claude',
      }).env;
    }
    const headerHelper = ctx.dynamicHeaderHelpers?.get(server.name);
    if (server.headers) {
      const headers = { ...server.headers };
      for (const headerName of headerHelper?.headerNames || []) delete headers[headerName];
      if (Object.keys(headers).length > 0 || !headerHelper) entry.headers = headers;
    }
    if (headerHelper) entry.headersHelper = headerHelper.command;
    mcpServersMap[server.name] = entry;
    const versionDir = ctx.publicSeat && selectedMcpVersionDir(spawnCommand);
    if (versionDir) ctx.mcpReadDirectories?.push(versionDir);
  }
  return { mcpServers: mcpServersMap };
};

// Materialized once per spawn outside the workspace, then removed in the
// spawn's finally block. The JSON contains placeholders, never resolved
// Commonly credentials; Claude expands them from its one-run environment.
// Directory/file modes stay strict because this config still declares the
// agent's trusted MCP capabilities and endpoints.
const createMcpConfig = async (mcpServers, ctx = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'commonly-claude-mcp-'));
  const file = join(dir, 'mcp-config.json');
  let credential = null;
  try {
    await chmod(dir, 0o700);
    // Written BEFORE the config, because the config may only reference it. It
    // lives inside `dir` so the spawn's existing finally removes it with the
    // config — no second lifecycle to get wrong — and so it is inside the one
    // non-workspace path the Seatbelt profile admits.
    credential = writeCredentialFile(ctx.runtimeToken, { agentName: ctx.agentName || 'agent', root: dir });
    const dynamicHeaderHelpers = credential?.path
      ? await createTokenHeaderHelpers(mcpServers, dir)
      : new Map();
    const unavailableMcp = [];
    const mcpReadDirectories = [];
    const config = buildMcpConfig(mcpServers, {
      ...ctx,
      credentialFile: credential?.path || null,
      dynamicHeaderHelpers,
      unavailableMcp,
      mcpReadDirectories,
    });
    await writeFile(
      file,
      JSON.stringify(config, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    // writeFile's mode only applies when creating. Pin the final mode too so
    // this stays correct if the implementation ever starts reusing the path.
    await chmod(file, 0o600);
    const expansionEnv = buildMcpExpansionEnv(config, {
      ...ctx,
      credentialFile: credential?.path || null,
      headersHelperUsesCredentialFile: dynamicHeaderHelpers.size > 0,
    });
    if (expansionEnv[CREDENTIAL_KEY]) {
      // eslint-disable-next-line no-console
      console.warn(
        `[claude] this declaration references ${CREDENTIAL_KEY} in a field claude `
        + 'substitutes literally (args, url, unsupported headers, or a larger string), so the '
        + "value stays in claude's environment for this spawn and every MCP child "
        + `inherits it. Put the credential on the entry's env to get the file channel.`,
      );
    }
    return { dir, file, credential, expansionEnv, unavailableMcp, mcpReadDirectories };
  } catch (err) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
};

// ── argv preparation — environment-aware ────────────────────────────────────

// Claude's npm installer commonly puts the binary in ~/.local/bin, while
// launchd/supervisor environments intentionally use a small PATH. Keep the
// command name for the legacy spawn contract, but add this directory to the
// child environment and to every detection lookup so a daemon does not report
// a false "adapter unavailable" (or hit spawn ENOENT) merely because it was
// started outside an interactive shell.
const withClaudePath = (input) => {
  const output = { ...(input || process.env) };
  const localBin = join(homedir(), '.local', 'bin');
  const entries = String(output.PATH || '')
    .split(delimiter)
    .filter(Boolean);
  if (!entries.includes(localBin)) entries.push(localBin);
  output.PATH = entries.join(delimiter);
  return output;
};

// Resolve the absolute path of `claude` so bwrap's execvp doesn't depend on
// PATH being correctly populated inside the sandbox namespace. Surfaced live
// during the 2026-04-17 demo validation: bwrap silently inherits parent
// PATH but cannot reach the user's `~/.local/bin` without an absolute path
// argv[0], even when that directory is bound read-only into the sandbox.
const resolveClaudePath = (env = process.env) => {
  // Defensive: spawnSync can return undefined under aggressive mocks (the
  // adapters.claude.environment.test.mjs suite stubs child_process so no real
  // process runs). Treat any failure mode as "use the bare command name."
  let which;
  try {
    which = spawnSync('which', ['claude'], {
      encoding: 'utf8',
      env: withClaudePath(env),
    });
  } catch { /* ignore */ }
  if (which && which.status === 0) {
    const p = (which.stdout || '').trim();
    if (p) {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    }
  }
  return 'claude';
};

// Where the claude this host would run is installed: the folder the Linux
// workspace jail has to bind, since it binds the system binary folders only.
// Null when the binary cannot be located (a bare name, a dangling link).
const resolveClaudeInstall = (env) => {
  const claudeBin = resolveClaudePath(env);
  if (!isAbsolute(claudeBin)) return { claudeBin, claudeInstall: null };
  try {
    return { claudeBin, claudeInstall: dirname(realpathSync(claudeBin)) };
  } catch {
    return { claudeBin, claudeInstall: null };
  }
};

// A jail that cannot carry claude would fail inside at every spawn.
const claudeInstallRefusal = (claudeBin) => new Error(
  'workspace Claude agents on Linux need Claude Code on PATH, so the sandbox can carry its install; '
  + `\`${claudeBin}\` could not be resolved`,
);

const prepareArgv = async (innerArgv, ctx) => {
  const env = ctx.environment;
  const claudeEnv = withClaudePath(ctx.claudeEnv);
  if (!env) return { cmd: 'claude', args: innerArgv, env: claudeEnv };

  let allowedPatterns = [];
  if (Array.isArray(env.mcp) && env.mcp.length > 0) {
    if (!ctx.mcpConfigPath) {
      throw new Error('claude MCP config was declared but no per-spawn config path was prepared');
    }
    // Insert --mcp-config immediately after the subcommand-style `-p` block
    // so claude parses it before prompt collection begins.
    innerArgv = [...innerArgv, '--mcp-config', ctx.mcpConfigPath];
    // Pre-approve every MCP tool from the declared servers (`mcp__<name>__*`).
    // Without this claude runs in non-interactive `-p` mode and asks for
    // permission before invoking any MCP tool — the wrapper has no way to
    // approve, so the model just narrates the request and bails. The user
    // already opted into these servers by declaring them in the env spec, so
    // auto-allowing the corresponding tool prefix is the honest default.
    // Surfaced live during the 2026-04-17 cross-agent demo validation.
    allowedPatterns = env.mcp
      .map((server) => server && server.name)
      .filter(Boolean)
      .map((name) => `mcp__${name}__*`);
  }

  const sandboxTrust = env.sandbox?.trust;
  const sandboxMode = resolvePublicSandboxMode(env.sandbox);
  const grants = workspaceGrants(env.sandbox);
  const publicNativeSandbox = isConfinedTrust(sandboxTrust)
    && PUBLIC_SANDBOX_MODES.has(sandboxMode);
  // A public trust is ONE contract on both platforms: the jail bounds the
  // filesystem and the policy bounds the tools. The bwrap branch below used to
  // get the jail only — a derived Linux seat kept Bash/Write/WebFetch and ran on
  // the operator's own Claude settings inside the namespace.
  const publicBwrapSandbox = sandboxTrust === 'public' && sandboxMode === 'bwrap';
  // A workspace seat on Linux: the same jail, with the workspace tier's policy
  // and a HOME of its own outside the project.
  const workspaceBwrapSandbox = sandboxTrust === 'workspace' && sandboxMode === 'bwrap';
  const commitHooksPath = ctx.commitAttributionEnv?.COMMONLY_AGENT_HOOKS_PATH || null;
  const originalHooksPath = ctx.commitAttributionEnv?.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH || null;
  const commitHookExecutables = commitHooksPath
    ? supportedGitHooks().map((hookName) => join(commitHooksPath, hookName))
    : [];
  const originalHookExecutables = originalHooksPath
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
  // A public trust MUST resolve to an enforced mode. Absent mode is resolved
  // above; anything else that lands here (the literal 'none', a typo, a
  // non-string) used to fall through to the bare `claude` spawn below — an
  // unconfined seat with a public record, which is how a record can claim
  // confinement it never applies.
  if (isConfinedTrust(sandboxTrust) && !publicNativeSandbox && sandboxMode !== 'bwrap') {
    throw new Error(
      `${sandboxTrust} Claude agents require an enforced sandbox mode `
      + `(workspace or read-only on macOS, bwrap elsewhere), got ${JSON.stringify(sandboxMode)}`,
    );
  }
  if (publicNativeSandbox) {
    if (process.platform !== 'darwin') {
      throw new Error(
        `public Claude sandbox.mode=${sandboxMode} maps to Seatbelt on macOS; `
        + 'use sandbox.mode=bwrap on Linux',
      );
    }
    if (!ctx.publicClaudeState) {
      throw new Error('public Claude state was not prepared before argv construction');
    }
    innerArgv = [
      ...innerArgv,
      ...buildPublicClaudePolicyArgs(allowedPatterns, {
        trust: sandboxTrust, allow: grants, memoryWithheld: ctx.memoryWithheld === true,
      }),
      ...(ctx.publicSkillArgs || []),
    ];
    const claudeBin = resolveClaudePath(claudeEnv);
    // Only stdio servers have a `command`; an HTTP entry (the grant broker)
    // carries a `url` instead, and `isAbsolute(undefined)` throws — every
    // confined spawn of a seat with a broker grant died here (2026-09-18).
    const mcpExecutables = (env.mcp || [])
      .map((server) => server?.command?.[0])
      .filter((command) => typeof command === 'string' && isAbsolute(command));
    const wrapped = wrapArgvWithSeatbelt([claudeBin, ...innerArgv], {
      workspacePath: ctx.cwd,
      workspaceAccess: sandboxMode === 'read-only'
        || (sandboxTrust === 'workspace' && !grants.includes('write')) ? 'read' : 'write',
      readOnlyWorkspaceEntries: sandboxTrust === 'workspace' ? ['.git'] : [],
      executablePath: claudeBin,
      statePath: ctx.publicClaudeState.statePath,
      mcpConfigDir: ctx.mcpConfigDir,
      executablePaths: [
        ...mcpExecutables,
        ...(ctx.workspaceGit ? [ctx.workspaceGit.executable] : []),
        ...commitHookExecutables,
        ...originalHookExecutables,
      ],
      allowClaudeRuntimeAccess: true,
      readOnlyDirectories: [
        ...(ctx.mcpReadDirectories || []),
        ...(ctx.workspaceGit?.readDirectories || []),
      ],
      readOnlyPaths: ctx.workspaceGit?.readPaths || [],
    });
    return {
      cmd: wrapped[0],
      args: wrapped.slice(1),
      env: claudeEnv,
    };
  }

  if (publicBwrapSandbox || workspaceBwrapSandbox) {
    // The mode is chosen here, so the mechanism is verified here: a missing
    // bwrap must fail the seat's derivation with an actionable message, not
    // every one of its spawns with a bare ENOENT. On a non-Linux
    // host this reports the macOS-only message, same as the wrapper would.
    const bwrap = (ctx._detectBwrap || detectBwrap)();
    if (!bwrap.available) {
      throw new Error(`${sandboxTrust} Claude agents require bwrap: ${bwrap.error}`);
    }
    if (workspaceBwrapSandbox && !ctx.publicClaudeState) {
      throw new Error('workspace Claude state was not prepared before argv construction');
    }
    innerArgv = [
      ...innerArgv,
      ...buildPublicClaudePolicyArgs(allowedPatterns, workspaceBwrapSandbox
        ? { trust: sandboxTrust, allow: grants, memoryWithheld: ctx.memoryWithheld === true }
        : { memoryWithheld: ctx.memoryWithheld === true }),
      ...(ctx.publicSkillArgs || []),
    ];
  } else if (allowedPatterns.length > 0) {
    innerArgv = [...innerArgv, '--allowedTools', ...allowedPatterns];
  }
  if (workspaceBwrapSandbox) {
    // Seatbelt denies writes under .git by path, present or not. A bwrap mount
    // needs the path to exist, so a writable project without a .git could get
    // one from the child, hooks included, that the person's next git command
    // runs. Refuse that rather than create anything in their project.
    if (grants.includes('write')) {
      const gitEntry = await statOrNull(join(ctx.cwd, '.git'));
      if (!gitEntry || gitEntry.isSymbolicLink()) {
        throw new Error('workspace Claude agents with write on Linux need the project to be a git '
          + `repository (run \`git init\` in ${ctx.cwd}), so its .git can be held read-only`);
      }
    }
    const { claudeBin, claudeInstall } = resolveClaudeInstall(claudeEnv);
    if (!claudeInstall) throw claudeInstallRefusal(claudeBin);
    const { statePath } = ctx.publicClaudeState;
    const wrapped = wrapArgvWithBwrap([claudeBin, ...innerArgv], env, {
      workspacePath: ctx.cwd,
      workspaceReadOnly: !grants.includes('write'),
      readOnlyWorkspaceEntries: ['.git'],
      homePath: statePath,
      writablePaths: [statePath],
      readOnlyPaths: [
        ctx.mcpConfigDir, commitHooksPath, originalHooksPath,
        ...(ctx.mcpReadDirectories || []),
        ...(ctx.workspaceGit?.readDirectories || []),
        ...(ctx.workspaceGit?.readPaths || []),
      ].filter(Boolean),
      // The binaries the jail runs: claude (a user-local install is outside
      // the default binds, and its link points into a versions folder), the
      // node that runs the stdio MCP servers, and the git the history tool runs.
      optionalReadOnlyPaths: [...new Set([
        dirname(claudeBin), claudeInstall, dirname(process.execPath),
        ctx.workspaceGit ? dirname(ctx.workspaceGit.executable) : null,
        // A claude not found on PATH is left bare and fails at spawn; its
        // dirname is '.', which is not a path to bind.
      ].filter((p) => p && isAbsolute(p)))],
    });
    // TASK-440 reads the transcript from the HOME the child wrote under.
    return { cmd: wrapped[0], args: wrapped.slice(1), env: claudeEnv, childHome: statePath };
  }
  if (sandboxMode === 'bwrap') {
    const claudeBin = resolveClaudePath(claudeEnv);
    const wrapped = wrapArgvWithBwrap([claudeBin, ...innerArgv], env, {
      workspacePath: ctx.cwd,
      readOnlyPaths: [ctx.mcpConfigDir, commitHooksPath, originalHooksPath, ...(ctx.mcpReadDirectories || [])].filter(Boolean),
    });
    // bwrap sets the child's HOME to the workspace (wrapArgvWithBwrap's
    // default), so the child's transcript lands under the workspace, not the
    // HOME the host process sees. TASK-440 reads from here.
    return { cmd: wrapped[0], args: wrapped.slice(1), env: claudeEnv, childHome: ctx.cwd };
  }
  return { cmd: 'claude', args: innerArgv, env: claudeEnv };
};

export default {
  get requiresModel() { return seatModelRequired(); },
  name: 'claude',
  // Identity-bearing runtime tag written into AgentInstallation.config.runtime
  // by `commonly agent attach`. The CLI command stays `commonly agent attach
  // claude` (ergonomic) but the persisted runtimeType matches AGENT_TYPES so
  // the inspector + API can classify it as the same thing as cloud Claude
  // Code. Pair with `host: 'byo'` (set in agent.js) to disambiguate from the
  // hosted variant.
  runtimeType: 'claude-code',

  inventory: () => claudeRuntimeInventory({ env: withClaudePath(process.env) }),

  async detect() {
    try {
      const claudeEnv = withClaudePath(process.env);
      const res = spawnSync('claude', ['--version'], {
        encoding: 'utf8', timeout: 5000,
        env: claudeEnv,
      });
      if (res.error || res.status !== 0) return null;
      // `claude --version` prints e.g. "2.5.1 (Claude Code)" — first token is enough
      const version = (res.stdout || '').trim().split(/\s+/)[0] || 'unknown';
      // Best-effort resolve of the binary path for clearer UX ("claude detected
      // at /usr/local/bin/claude"). Falls back to the bare command name on
      // platforms without `which` (e.g. Windows).
      const where = spawnSync('which', ['claude'], {
        encoding: 'utf8',
        env: claudeEnv,
      });
      const path = where.status === 0 ? (where.stdout || '').trim() || 'claude' : 'claude';
      return { path, version };
    } catch {
      return null;
    }
  },

  async spawn(prompt, rawCtx = {}) {
    const seatModel = requireSeatModel(rawCtx.environment, 'claude');
    // `sandbox.trust: 'internal'` is refused for new declarations and read as
    // `public` for a record that already carries it; such a seat is confined
    // where it can be and refuses to derive where it cannot.
    // Resolved ONCE here and threaded to BOTH consumers — the public-state
    // preparation below and the argv builder — because two independent reads of
    // one declaration is exactly how this seat crashed with "public Claude
    // state was not prepared" instead of spawning confined.
    const ctx = rawCtx.environment
      ? withWorkspaceGit({
        ...rawCtx,
        environment: {
          ...rawCtx.environment,
          sandbox: normalizeSandboxTrust(rawCtx.environment.sandbox),
        },
      })
      : rawCtx;
    if (isLegacySandboxTrust(rawCtx.environment?.sandbox)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[claude] sandbox.trust=internal is no longer accepted: it reads as '
        + 'confinement and engaged none. Resolving this seat as trust=public, so '
        + 'it is confined or it refuses to derive — never unconfined (Wren 69585).',
      );
    }
    const isResume = !!ctx.sessionId;
    const sessionId = ctx.sessionId || randomUUID();
    // Passed through UNCOALESCED. `ctx.memoryLongTerm || ''` was here, and
    // `null || ''` is `''` — which routed the unreadable case straight into
    // the empty-memory branch and made the whole distinction unreachable from
    // the only two paths that build a real prompt. buildPrompt handles
    // undefined and '' as absence itself; it does not need a guard, it needs
    // the value.
    const publicTrust = isConfinedTrust(ctx.environment?.sandbox?.trust);
    // Only a stranger-facing seat is witnessed (TASK-256). A workspace seat is
    // confined too, but it answers its own team, and an outage it narrates
    // there is a signal, not a leak.
    const witnessedMcp = ctx.environment?.sandbox?.trust === 'public' ? ctx.environment?.mcp : null;
    const workCues = publicTrust ? [] : WORK_CUES;
    const fullPrompt = buildPrompt(prompt, ctx.memoryLongTerm, {
      freshSession: !isResume,
      workCues,
      memoryWithheld: ctx.memoryWithheld === true,
    });
    const sessionFlag = isResume ? '--resume' : '--session-id';
    // Model pin from the ADR-008 environment spec. Absent it, claude picks its
    // own default — which is how a fleet of ten agents ended up running three
    // different Opus versions that nobody chose and nothing recorded, with one
    // seat named after a model it does not run.
    //
    // Computed ONCE and spread into BOTH arg builders. The session-recovery
    // path at the bottom of this function constructs its own array, and a model
    // present in one but not the other means a retry silently runs a different
    // model than the turn it is replacing — the same drifting-copy shape that
    // has bitten this codebase repeatedly.
    // `effort` rides in the same array for the same reason: an order
    // like "flip all fable agents into fable 5.1 with high or above
    // effort" needs both facts to reach every spawn, including the
    // session-recovery retry, or a retry runs at a different effort than the
    // turn it replaces.
    const modelArgs = [
      ...(seatModel ? ['--model', seatModel] : []),
      ...(ctx.environment?.effort ? ['--effort', String(ctx.environment.effort)] : []),
    ];
    const baseArgs = ['-p', fullPrompt, ...STREAM_ARGS, sessionFlag, sessionId, ...modelArgs];

    let mountedSkills = [];
    let skillMount = { mounted: [], conflicted: [] };
    // A workspace seat's folder is the person's project, and mountSkills writes
    // from this host process, outside any jail. Its skills are copied to the
    // run loop's scratch folder instead and reach it as prompt text.
    const skillDir = ctx.environment?.sandbox?.trust === 'workspace' ? ctx.skillMountDir : ctx.cwd;
    if (ctx.environment && skillDir) {
      const skills = await mountSkills(ctx.environment, skillDir);
      mountedSkills = skills.mounted;
      skillMount = skills;
      if (skills.conflicted.length > 0) {
        for (const c of skills.conflicted) {
          // eslint-disable-next-line no-console
          console.warn(`[claude] skill not mounted (${c.reason}): ${c.path}`);
        }
      }
    }

    let mcpConfig = null;
    let publicClaudeState = null;
    let publicSkillArgs = [];
    const publicNativeSandbox = publicTrust
      && PUBLIC_SANDBOX_MODES.has(resolvePublicSandboxMode(ctx.environment?.sandbox));
    const publicBwrapSandbox = publicTrust
      && resolvePublicSandboxMode(ctx.environment?.sandbox) === 'bwrap';
    const workspaceBwrapSandbox = ctx.environment?.sandbox?.trust === 'workspace'
      && resolvePublicSandboxMode(ctx.environment?.sandbox) === 'bwrap';
    try {
      // Trust is normalized at entry (legacy `internal` reads as public). The
      // MCP policy follows trust alone, whatever confines the seat: a public
      // bwrap seat needs a host-prepared build exactly as a Seatbelt one does
      // (#2247).
      if (publicNativeSandbox) {
        publicClaudeState = await preparePublicClaudeState(ctx);
      } else if (workspaceBwrapSandbox) {
        // Checked before the state is prepared, so a host that cannot run the
        // jail never gets a copy of the login.
        const bwrap = (ctx._detectBwrap || detectBwrap)();
        if (!bwrap.available) throw new Error(`workspace Claude agents require bwrap: ${bwrap.error}`);
        const { claudeBin, claudeInstall } = resolveClaudeInstall(withClaudePath(ctx.env));
        if (!claudeInstall) throw claudeInstallRefusal(claudeBin);
        publicClaudeState = await prepareWorkspaceBwrapClaudeState(ctx);
      }
      if (publicTrust) {
        const prompt = await publicSkillPromptArgs(mountedSkills);
        publicSkillArgs = prompt.args;
        skillMount = {
          mounted: prompt.included,
          conflicted: [
            ...skillMount.conflicted,
            ...mountedSkills.filter((source) => !prompt.included.includes(source))
              .map((path) => ({ path, reason: 'not-inlined' })),
          ],
        };
      }
      if (ctx.environment && ctx.cwd) ctx.onSkillsLinked?.(skillMount);
      if (Array.isArray(ctx.environment?.mcp) && ctx.environment.mcp.length > 0) {
        mcpConfig = await createMcpConfig(ctx.environment.mcp, {
          runtimeToken: ctx.runtimeToken,
          instanceUrl: ctx.instanceUrl,
          agentName: ctx.agentName,
          publicSeat: publicTrust,
        });
      }
      if (mcpConfig?.unavailableMcp.length) throw publicMcpUnavailableError(mcpConfig.unavailableMcp);
      const claudeEnv = buildClaudeEnv(
        ctx.env,
        publicClaudeState,
        mcpConfig?.expansionEnv,
        mcpConfig?.credential?.path || null,
        publicTrust,
      );
      if ((publicNativeSandbox || publicBwrapSandbox) && ctx.commitAttributionEnv) {
        Object.assign(claudeEnv, ctx.commitAttributionEnv);
      }
      const spawnCtx = {
        ...ctx,
        mcpConfigPath: mcpConfig?.file || null,
        mcpConfigDir: mcpConfig?.dir || null,
        mcpReadDirectories: mcpConfig?.mcpReadDirectories || [],
        publicClaudeState,
        publicSkillArgs,
        claudeEnv,
      };
      const { cmd, args, env, childHome } = await prepareArgv(baseArgs, spawnCtx);
      const stdout = await runClaude({
        cmd,
        args,
        cwd: ctx.cwd,
        env,
        timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
        // The values this spawn was handed, for the failure tail's exact-match
        // check. Snapshot before the spawn: claude is subscription-authenticated
        // and its provider key is not an env var here, so the seat credential is
        // the value a tail can echo back.
        credentials: spawnCredentials(spawnCtx),
        spawnImpl: ctx._spawnImpl, onSpawn: ctx.onSpawn, controls: controlsFromArguments(modelArgs, { modelFlag: '--model', effortFlag: '--effort' }), // test seam only — do not use in production
        ownGroup: wantsOwnProcessGroup(ctx),
        transcriptPath: claudeTranscriptPath({
          cwd: physicalPath(ctx.cwd), sessionId, configDir: claudeConfigDirFor({ ...env, HOME: childHome || env?.HOME }),
        }),
        lockProbe: ctx._lockProbe, // test seams only
        stallKillGraceMs: ctx._stallKillGraceMs,
        processTable: ctx._processTable,
        survivorIo: ctx._survivorIo,
      });
      // TASK-440: the context this turn left, read from the transcript the
      // child wrote under its own env (an isolated HOME for public seats).
      const contextTokens = claudeContextTokens({
        cwd: physicalPath(ctx.cwd), sessionId, configDir: claudeConfigDirFor({ ...env, HOME: childHome || env?.HOME }),
      });
      return {
        text: turnReply(stdout, { credentials: spawnCredentials(spawnCtx), publicMcp: witnessedMcp }),
        newSessionId: sessionId,
        contextTokens,
      };
    } catch (err) {
      // A public seat's refusal is not a session-store failure, whatever its
      // message happens to contain: it must reach the run loop, never the
      // fresh-session retry below (#2247).
      if ([PUBLIC_MCP_UNAVAILABLE_CODE, PUBLIC_MCP_NOT_READY_CODE, PUBLIC_TOOL_FAILED_CODE].includes(err?.code)) throw err;
      // Self-heal against a corrupted session store. If the persisted id is
      // already in use (or claude has forgotten about it), discard it and
      // restart the turn with a fresh UUID. Without this, a single bad
      // session id poisons every subsequent event re-delivery.
      if (isResume && /already in use|no conversation|no session/i.test(String(err.message))) {
        const freshId = randomUUID();
        // The retry creates a new underlying CLI session. Rebuild its prompt
        // as fresh too: otherwise a session-recovery path is the one fresh
        // session that misses the durable-state cue.
        const freshPrompt = buildPrompt(prompt, ctx.memoryLongTerm, {
          freshSession: true,
          workCues,
          memoryWithheld: ctx.memoryWithheld === true,
        });
        const retryBase = ['-p', freshPrompt,
        ...STREAM_ARGS, '--session-id', freshId, ...modelArgs];
        const retryCtx = {
          ...ctx,
          mcpConfigPath: mcpConfig?.file || null,
          mcpConfigDir: mcpConfig?.dir || null,
          mcpReadDirectories: mcpConfig?.mcpReadDirectories || [],
          publicClaudeState,
          publicSkillArgs,
          claudeEnv: buildClaudeEnv(
            ctx.env,
            publicClaudeState,
            mcpConfig?.expansionEnv,
            mcpConfig?.credential?.path || null,
            publicTrust,
          ),
        };
        if ((publicNativeSandbox || publicBwrapSandbox) && ctx.commitAttributionEnv) {
          Object.assign(retryCtx.claudeEnv, ctx.commitAttributionEnv);
        }
        const retry = await prepareArgv(retryBase, retryCtx);
        const stdout = await runClaude({
          cmd: retry.cmd,
          args: retry.args,
          cwd: ctx.cwd,
          env: retry.env,
          timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
          credentials: spawnCredentials(retryCtx),
          spawnImpl: ctx._spawnImpl, onSpawn: ctx.onSpawn, controls: controlsFromArguments(modelArgs, { modelFlag: '--model', effortFlag: '--effort' }),
          ownGroup: wantsOwnProcessGroup(ctx),
          transcriptPath: claudeTranscriptPath({
            cwd: physicalPath(ctx.cwd), sessionId: freshId,
            configDir: claudeConfigDirFor({ ...retry.env, HOME: retry.childHome || retry.env?.HOME }),
          }),
          lockProbe: ctx._lockProbe,
          stallKillGraceMs: ctx._stallKillGraceMs,
          processTable: ctx._processTable,
          survivorIo: ctx._survivorIo,
        });
        const contextTokens = claudeContextTokens({
          cwd: physicalPath(ctx.cwd), sessionId: freshId,
          configDir: claudeConfigDirFor({ ...retry.env, HOME: retry.childHome || retry.env?.HOME }),
        });
        return {
          text: turnReply(stdout, { credentials: spawnCredentials(retryCtx), publicMcp: witnessedMcp }),
          newSessionId: freshId,
          contextTokens,
        };
      }
      throw err;
    } finally {
      if (mcpConfig?.dir) {
        try { await rm(mcpConfig.dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  },
};
