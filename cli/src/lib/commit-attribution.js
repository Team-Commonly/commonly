import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const GIT_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-pre-submit',
  'p4-prepare-changelist',
  'p4-changelist',
  'p4-post-changelist',
  'post-index-change',
];

const cleanSingleLine = (value, fallback) => {
  let cleaned = '';
  for (const character of String(value ?? '')) {
    const codePoint = character.codePointAt(0);
    cleaned += codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }
  cleaned = cleaned
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
};

// Use an email-local-part-safe reversible id. URI escapes introduce `%`, which
// Git does not accept in a co-author trailer address. Keep the reversible form
// while it fits the 64-character email local-part limit; longer identities use
// a stable hash so GitHub can still lift the co-author on squash.
const seatAddressId = (agentName, instanceId) => {
  const identity = JSON.stringify([
    cleanSingleLine(agentName, 'agent'),
    cleanSingleLine(instanceId, 'default'),
  ]);
  const reversibleId = Buffer.from(identity).toString('base64url');
  if (reversibleId.length <= 64) return reversibleId;
  return `sha256-${createHash('sha256').update(identity).digest('base64url')}`;
};

// This probe runs before every turn and blocks the listener's event loop, so a
// git child that never exits (one waiting on an inherited stdin, or one whose
// open() the OS holds pending consent) must not stall the seat. On timeout
// spawnSync kills the child and sets result.error; the wrapper hook then
// resolves the original hooks itself at commit time.
const GIT_PROBE_TIMEOUT_MS = 5000;

const directoryOrNull = (path) => {
  try {
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
};

// One git config value: quotes group, a backslash escapes the next character,
// and an unquoted # or ; starts a comment.
const configValue = (raw) => {
  let value = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '\\' && index + 1 < raw.length) {
      index += 1;
      value += raw[index];
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && (character === '#' || character === ';')) {
      break;
    } else {
      value += character;
    }
  }
  return value.trim();
};

// The last core.hooksPath in one config file, or null. `include` and
// conditional includes are not followed.
const configuredHooksPath = (configPath) => {
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  let inCore = false;
  let hooksPath = null;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    const section = /^\[\s*([A-Za-z0-9.-]+)\s*("[^"]*")?\s*\]/.exec(line);
    if (section) {
      inCore = section[1].toLowerCase() === 'core' && !section[2];
      line = line.slice(section[0].length).trim();
    }
    const entry = inCore && /^hookspath\s*=(.*)$/i.exec(line);
    if (entry) hooksPath = configValue(entry[1]);
  }
  return hooksPath || null;
};

// The hooks directory a commit in `cwd` would use, read from the repository's
// own files without running git: core.hooksPath from the repository config,
// else the hooks folder of the common git directory (a linked worktree shares
// its main repository's). Global config and includes are not read. `~` expands
// against the HOME the probe gave git, as git itself would.
const hooksPathFromGitFiles = (cwd, env) => {
  let top = resolve(cwd);
  let entry = join(top, '.git');
  let entryStat = null;
  for (;;) {
    try {
      entryStat = statSync(entry);
      break;
    } catch {
      if (dirname(top) === top) return null;
      top = dirname(top);
      entry = join(top, '.git');
    }
  }
  let gitDir = entry;
  if (entryStat.isFile()) {
    let pointer = null;
    try {
      pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(entry, 'utf8'));
    } catch {
      // Unreadable: the same as no repository.
    }
    if (!pointer) return null;
    gitDir = resolve(top, pointer[1]);
  }
  let commonDir = gitDir;
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    // A main repository has no commondir file.
  }
  const configured = configuredHooksPath(join(commonDir, 'config'));
  if (!configured) return directoryOrNull(join(commonDir, 'hooks'));
  if (configured === '~' || configured.startsWith('~/')) {
    return env.HOME ? directoryOrNull(join(env.HOME, configured.slice(1))) : null;
  }
  // Git runs hooks from the top of the working tree, so a relative path
  // resolves there.
  return directoryOrNull(resolve(top, configured));
};

const resolveOriginalHooksPath = (cwd, env) => {
  const result = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
    {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );
  if (result.error?.code === 'ETIMEDOUT') {
    // The open() that stalled git would stall this process too, and a
    // synchronous read cannot be timed out, so nothing is read here. A git
    // that cannot open the repository cannot commit in it either.
    // eslint-disable-next-line no-console
    console.warn(`[commit-attribution] git did not answer in ${GIT_PROBE_TIMEOUT_MS / 1000}s in ${cwd}, `
      + 'so a confined seat is not granted this repository\'s hooks this turn');
    return null;
  }
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    // A confined seat can only run the hooks it is granted. A hook it is not
    // granted is skipped without a word, or refuses the commit where the jail
    // can see the file but not run it. So read the hooks directory from the
    // repository's files instead.
    const fallback = hooksPathFromGitFiles(cwd, env);
    if (fallback) {
      const reason = result.error?.code || `exit ${result.status}`;
      // eslint-disable-next-line no-console
      console.warn(`[commit-attribution] git could not report the hooks directory (${reason}), `
        + `so ${fallback} was read from the repository's files`);
    }
    return fallback;
  }
  return directoryOrNull(resolve(result.stdout.trim()));
};

const resolveGitConfigCount = (env) => {
  const raw = env.GIT_CONFIG_COUNT ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(String(raw))) {
    throw new Error(`cannot enable commit attribution: GIT_CONFIG_COUNT is invalid (${raw})`);
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) {
    throw new Error('cannot enable commit attribution: GIT_CONFIG_COUNT is out of range');
  }
  return count;
};

const wrapperHook = () => `#!/bin/sh
# Commonly CLI commit attribution. Preserve the repository's configured hooks.
hook_name=\${0##*/}
config_index=$COMMONLY_AGENT_GIT_CONFIG_INDEX
base_count=$COMMONLY_AGENT_GIT_CONFIG_BASE_COUNT
case "$config_index:$base_count" in
  *[!0-9:]*|:*) exit 1 ;;
esac
GIT_CONFIG_COUNT=$base_count
export GIT_CONFIG_COUNT
unset "GIT_CONFIG_KEY_$config_index" "GIT_CONFIG_VALUE_$config_index"

# Read the target repository's file-backed config while excluding process-level
# GIT_CONFIG_* overlays inherited from the workspace seat.
if original_hooks=$(GIT_CONFIG_COUNT=0 git config --path --get core.hooksPath 2>/dev/null); then
  :
else
  git_common_dir=$(GIT_CONFIG_COUNT=0 git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || git_common_dir=
  original_hooks=
  if [ -n "$git_common_dir" ]; then
    original_hooks="$git_common_dir/hooks"
  fi
fi
if [ -n "$original_hooks" ] && [ "$original_hooks" != "$COMMONLY_AGENT_HOOKS_PATH" ]; then
  original_hook="$original_hooks/$hook_name"
  if [ -x "$original_hook" ]; then
    "$original_hook" "$@"
    hook_status=$?
    if [ "$hook_status" -ne 0 ]; then
      exit "$hook_status"
    fi
  fi
fi

if [ "$hook_name" = "prepare-commit-msg" ] && [ -n "$1" ]; then
  git interpret-trailers --in-place --if-exists=addIfDifferent \\
    --trailer "Co-authored-by: $COMMONLY_AGENT_SEAT_NAME <$COMMONLY_AGENT_SEAT_ID@agents.commonly.invalid>" \\
    --trailer "Agent-Model: $COMMONLY_AGENT_ADAPTER/$COMMONLY_AGENT_MODEL/$COMMONLY_AGENT_EFFORT" \\
    "$1"
  exit $?
fi
exit 0
`;

/**
 * Install a per-spawn Git hook proxy and return an environment for the CLI
 * child. The proxy delegates every standard hook to the repository's original
 * hook directory, then adds Commonly trailers after an existing
 * prepare-commit-msg hook has had its say.
 */
export const prepareCommitAttribution = ({
  cwd,
  env = process.env,
  agentName,
  displayName,
  instanceId = 'default',
  adapter,
  model,
  effort,
}) => {
  const configIndex = resolveGitConfigCount(env);
  const originalHooksPath = resolveOriginalHooksPath(cwd, env);
  const hooksDirectory = mkdtempSync(join(tmpdir(), 'commonly-agent-hooks-'));
  try {
    const hookSource = wrapperHook();
    for (const hookName of GIT_HOOKS) {
      const hookPath = join(hooksDirectory, hookName);
      writeFileSync(hookPath, hookSource, { encoding: 'utf8', mode: 0o700 });
      accessSync(hookPath, constants.X_OK);
    }
  } catch (error) {
    rmSync(hooksDirectory, { recursive: true, force: true });
    throw error;
  }

  const safeAdapter = cleanSingleLine(adapter, 'unknown');
  const metadataEnv = {
    COMMONLY_AGENT_GIT_CONFIG_INDEX: String(configIndex),
    COMMONLY_AGENT_GIT_CONFIG_BASE_COUNT: String(configIndex),
    COMMONLY_AGENT_HOOKS_PATH: hooksDirectory,
    // The sandbox adapters allow the workspace's existing hook files. The
    // proxy resolves the target repo's path at hook time, and a confined seat
    // cannot run a hook outside what it was granted.
    ...(originalHooksPath ? { COMMONLY_AGENT_ORIGINAL_HOOKS_PATH: originalHooksPath } : {}),
    COMMONLY_AGENT_SEAT_NAME: cleanSingleLine(displayName || agentName, 'agent'),
    COMMONLY_AGENT_SEAT_ID: seatAddressId(agentName, instanceId),
    COMMONLY_AGENT_ADAPTER: safeAdapter,
    COMMONLY_AGENT_MODEL: cleanSingleLine(model, 'default'),
    COMMONLY_AGENT_EFFORT: cleanSingleLine(effort, 'default'),
  };
  const attributionEnv = {
    ...env,
    GIT_CONFIG_COUNT: String(configIndex + 1),
    [`GIT_CONFIG_KEY_${configIndex}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${configIndex}`]: hooksDirectory,
    ...metadataEnv,
  };
  const sandboxEnv = {
    ...metadataEnv,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksDirectory,
    COMMONLY_AGENT_GIT_CONFIG_INDEX: '0',
    COMMONLY_AGENT_GIT_CONFIG_BASE_COUNT: '0',
  };

  return {
    env: attributionEnv,
    sandboxEnv,
    hooksDirectory,
    cleanup: () => rmSync(hooksDirectory, { recursive: true, force: true }),
  };
};

export const supportedGitHooks = () => [...GIT_HOOKS];
