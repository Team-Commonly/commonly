import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

const resolveOriginalHooksPath = (cwd, env) => {
  const result = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
    { cwd, env, encoding: 'utf8' },
  );
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const hooksPath = resolve(result.stdout.trim());
  try {
    return statSync(hooksPath).isDirectory() ? hooksPath : null;
  } catch {
    return null;
  }
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

# Read only this repository's setting so global and process-level workspace
# hooks paths cannot redirect commits in another repository.
if original_hooks=$(git config --local --path --get core.hooksPath 2>/dev/null); then
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
    // proxy itself resolves core.hooksPath from the repository at hook time.
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
