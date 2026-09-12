import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'fs';
import { dirname, join, resolve as pathResolve, isAbsolute, relative } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop'];
export const DEFAULT_HOOK_TIMEOUT_MS = 3000;
export const MAX_HOOK_TIMEOUT_MS = 5000;

export const clampHookTimeoutMs = (value) => Math.min(
  MAX_HOOK_TIMEOUT_MS,
  Math.max(250, Math.trunc(Number.isFinite(Number(value)) ? Number(value) : DEFAULT_HOOK_TIMEOUT_MS)),
);

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * Keep hook commands free of bearer material.  The dispatcher reads
 * COMMONLY_AGENT_TOKEN from the process environment at invocation time.
 */
export const buildHookCommand = ({ agentName, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS }) => (
  `commonly agent hooks-forward ${shellQuote(agentName)} --timeout ${clampHookTimeoutMs(timeoutMs)}`
);

const hookEntry = ({ agentName, timeoutMs }) => ({
  matcher: '',
  hooks: [{
    type: 'command',
    command: buildHookCommand({ agentName, timeoutMs }),
    // Claude interprets this as seconds.  Keep it short so a dead backend
    // cannot stall every tool call for the 600s default.
    timeout: Math.ceil(clampHookTimeoutMs(timeoutMs) / 1000),
  }],
});

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const digestArgs = (value) => createHash('sha256').update(stableJson(value ?? {})).digest('hex');

/** Resolve a caller-side path and emit the repo-relative POSIX wire form. */
const localPath = (value, root = process.cwd()) => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  if (value.trim().split(/[\\/]/).includes('..')) return null;
  const resolvedRoot = pathResolve(root);
  const rootReal = (() => {
    try { return realpathSync(resolvedRoot); } catch { return resolvedRoot; }
  })();
  const absolute = isAbsolute(value) ? pathResolve(value) : pathResolve(resolvedRoot, value);
  if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}/`)) return null;
  let current = absolute;
  const suffix = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    suffix.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  let resolved;
  try { resolved = realpathSync(current); } catch { resolved = current; }
  const candidate = pathResolve(resolved, ...suffix);
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}/`)) return null;
  const repoPath = relative(rootReal, candidate).replaceAll('\\', '/');
  return repoPath || '.';
};

const inputPaths = (input = {}) => {
  const values = [input.path, input.file_path, input.filePath, input.target_file, input.paths]
    .flatMap((value) => Array.isArray(value) ? value : [value]);
  return values.filter((value) => typeof value === 'string' && value.trim());
};

/** Strip raw tool arguments before they leave the local harness. */
export const sanitizeHookPayload = (payload = {}, { cwd = process.cwd() } = {}) => {
  const event = payload.event || payload.hook_event_name || payload.event_name || '';
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const tool = payload.tool || payload.tool_name || payload.toolName;
  const root = payload.cwd || cwd;
  const declaredPaths = [payload.paths, payload.resolvedPaths]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === 'string');
  const paths = [...inputPaths(input), ...declaredPaths]
    .map((value) => localPath(value, root)).filter(Boolean);
  return {
    ...(event ? { event } : {}),
    ...(payload.eventId || payload.event_id ? { eventId: payload.eventId || payload.event_id } : {}),
    ...(typeof tool === 'string' && tool ? { tool } : {}),
    argsDigest: payload.argsDigest || payload.args_digest || digestArgs(input),
    ...(paths.length > 0 ? { paths: Array.from(new Set(paths)) } : {}),
  };
};

/** Merge Commonly hooks into settings while preserving every user setting. */
export const mergeHooksConfig = (
  existing = {},
  { agentName, events = HOOK_EVENTS, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS } = {},
) => {
  if (!agentName) throw new Error('agentName is required');
  const source = existing && typeof existing === 'object' ? existing : {};
  const hooks = source.hooks && typeof source.hooks === 'object' ? { ...source.hooks } : {};
  for (const event of events) {
    const prior = Array.isArray(hooks[event]) ? hooks[event] : [];
    // Replace only the entry generated for this agent; unrelated matchers and
    // command hooks remain byte-for-byte represented in the resulting JSON.
    const retained = prior.filter((entry) => !entry?.hooks?.some((h) => (
      h?.command?.includes(`commonly agent hooks-forward '${String(agentName).replaceAll("'", "'\\''")}'`)
    )));
    hooks[event] = [...retained, hookEntry({ agentName, timeoutMs })];
  }
  return { ...source, hooks };
};

export const settingsPathForScope = ({ scope = 'project', cwd = process.cwd(), home = homedir() } = {}) => {
  if (scope === 'user') return join(home, '.claude', 'settings.json');
  if (scope !== 'project') throw new Error("scope must be 'project' or 'user'");
  return join(cwd, '.claude', 'settings.local.json');
};

export const readJsonSettings = (filePath, fsApi = { readFileSync, existsSync }) => {
  if (!fsApi.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error.message}`);
  }
};

export const writeHooksConfig = ({
  filePath,
  agentName,
  scope = 'project',
  cwd = process.cwd(),
  home = homedir(),
  timeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
  fsApi = { readFileSync, writeFileSync, mkdirSync, existsSync },
} = {}) => {
  const target = filePath || settingsPathForScope({ scope, cwd, home });
  const existing = readJsonSettings(target, fsApi);
  const next = mergeHooksConfig(existing, { agentName, timeoutMs });
  fsApi.mkdirSync(dirname(target), { recursive: true });
  fsApi.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { filePath: target, config: next };
};

/**
 * Execute one hook event.  It is intentionally dependency-light so the
 * generated Claude command works on a fresh CLI install (Node 20's fetch).
 * On any transport failure, fail open with no output.  A deny is only the
 * positive decision returned by the Commonly endpoint; D7 does not let a
 * missing/slow ledger become an accidental write blocker.
 */
export const forwardHookEvent = async ({
  endpoint,
  token = process.env.COMMONLY_AGENT_TOKEN,
  input = '',
  timeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  stdout = (value) => process.stdout.write(value),
} = {}) => {
  let payload;
  try { payload = typeof input === 'string' ? JSON.parse(input || '{}') : input; } catch {
    payload = {};
  }
  const event = payload?.event || payload?.hook_event_name || payload?.event_name || '';
  const preTool = event === 'PreToolUse';
  if (!endpoint || !token || !fetchImpl) {
    return { acknowledged: false, reason: 'hook_unavailable' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampHookTimeoutMs(timeoutMs));
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(sanitizeHookPayload(payload)),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (preTool && body.permissionDecision === 'deny') {
      stdout(JSON.stringify({ permissionDecision: 'deny', ...(body.reason ? { reason: body.reason } : {}) }));
    }
    return body;
  } catch (error) {
    // Deliberately silent and exit-0 for every failure.  Claude's default is
    // fail-open, and an unavailable advisory hook must not block a tool.
    void error;
    return { acknowledged: false, reason: 'hook_unavailable' };
  } finally {
    clearTimeout(timer);
  }
};
