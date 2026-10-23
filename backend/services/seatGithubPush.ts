/** Trusted half of the confined host seat's push channel. Git runs only in a fresh bare repo. */
import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { GithubToolConnection } from './toolBrokerService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const GitHubAppService = require('./githubAppService');

const runFile = promisify(execFile);
const OID = /^[0-9a-f]{40}$/;
const ZERO_OID = '0'.repeat(40);
const MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
const safeRepoPart = (part: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(part)
  && !part.includes('..') && !part.endsWith('.');
const safeRef = (ref: string, agentUserId: string) => (
  ref.startsWith(`refs/heads/seat/${agentUserId}/`)
  && ref.length <= 220
  && ref.split('/').every((part) => safeRepoPart(part) && !part.endsWith('.lock'))
);

export class SeatPushError extends Error {
  constructor(public code: string, public statusCode = 403) { super(code); }
}

interface PushArgs {
  ref: string;
  baseOid: string;
  newOid: string;
  bundle: string;
}

/** Validate the wire shape before spending a provider call or writing a temp file. */
export const parseSeatPushArgs = (raw: Record<string, unknown>, agentUserId: string): PushArgs => {
  if (Object.keys(raw).some((key) => !['ref', 'baseOid', 'newOid', 'bundle'].includes(key))) {
    throw new SeatPushError('push_args_invalid', 400);
  }
  const { ref, baseOid, newOid, bundle } = raw;
  if (typeof ref !== 'string' || !safeRef(ref, agentUserId)
    || typeof baseOid !== 'string' || !OID.test(baseOid)
    || typeof newOid !== 'string' || !OID.test(newOid)
    || typeof bundle !== 'string' || bundle.length > Math.ceil((MAX_BUNDLE_BYTES * 4) / 3) + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(bundle)) {
    throw new SeatPushError('push_args_invalid', 400);
  }
  return { ref, baseOid, newOid, bundle };
};

/** Purely local Git proof after the provider objects have been fetched. */
export const validateSeatBundle = async (options: {
  git: (args: string[], cwd?: string, failure?: SeatPushError) => Promise<string>;
  repo: string;
  bundlePath: string;
  baseOid: string;
  newOid: string;
  oldOid: string;
}): Promise<void> => {
  const { git, repo, bundlePath, baseOid, newOid, oldOid } = options;
  await git(['cat-file', '-e', `${baseOid}^{commit}`], repo,
    new SeatPushError('bundle_base_not_in_provider', 400));
  const heads = await git(['bundle', 'list-heads', bundlePath]);
  const advertised = heads.split('\n').filter(Boolean);
  if (advertised.length !== 1 || advertised[0].split(/\s+/, 1)[0] !== newOid) {
    throw new SeatPushError('bundle_ref_invalid', 400);
  }
  await git(['bundle', 'verify', bundlePath], repo, new SeatPushError('bundle_invalid', 400));
  await git(['bundle', 'unbundle', bundlePath], repo, new SeatPushError('bundle_invalid', 400));
  await git(['cat-file', '-e', `${newOid}^{commit}`], repo, new SeatPushError('bundle_invalid', 400));
  await git(['fsck', '--no-reflogs', '--connectivity-only', newOid], repo,
    new SeatPushError('bundle_invalid', 400));
  await git(['merge-base', '--is-ancestor', baseOid, newOid], repo,
    new SeatPushError('non_fast_forward', 409));
  if (oldOid !== ZERO_OID) await git(['merge-base', '--is-ancestor', oldOid, newOid], repo,
    new SeatPushError('non_fast_forward', 409));
};

/** Provider CAS is independent of client push flags or advertised remote state. */
export const pushWithLease = async (options: {
  git: (args: string[], cwd?: string, failure?: SeatPushError) => Promise<string>;
  repo: string;
  url: string;
  ref: string;
  oldOid: string;
  newOid: string;
}): Promise<void> => {
  const { git, repo, url, ref, oldOid, newOid } = options;
  try {
    await git(['push', '--porcelain', `--force-with-lease=${ref}:${oldOid === ZERO_OID ? '' : oldOid}`,
      url, `${newOid}:${ref}`], repo);
  } catch {
    const latest = await git(['ls-remote', url, ref], repo);
    const latestOid = latest ? latest.split(/\s+/, 1)[0] : ZERO_OID;
    if (latestOid !== oldOid) throw new SeatPushError('stale_ref', 409);
    throw new SeatPushError('provider_git_failed', 502);
  }
};

/** All subprocess settings are backend-owned. The bundle controls no Git config, hook or remote. */
export const pushSeatBranch = async (
  raw: Record<string, unknown>, connection: GithubToolConnection, agentUserId: string,
): Promise<{ ref: string; oldOid: string; newOid: string }> => {
  const { ref, baseOid, newOid, bundle } = parseSeatPushArgs(raw, agentUserId);
  if (!safeRepoPart(connection.owner) || !safeRepoPart(connection.repo)) {
    throw new SeatPushError('repository_invalid');
  }
  const bytes = Buffer.from(bundle, 'base64');
  if (!bytes.length || bytes.length > MAX_BUNDLE_BYTES || bytes.toString('base64') !== bundle) {
    throw new SeatPushError('bundle_invalid', 400);
  }
  const directory = await mkdtemp(join(tmpdir(), 'seat-git-push-'));
  const repo = join(directory, 'repo.git');
  const bundlePath = join(directory, 'input.bundle');
  const url = `https://github.com/${connection.owner}/${connection.repo}.git`;
  try {
    const { token } = await GitHubAppService.getInstallationToken(connection.installationId);
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    const env = {
      PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `http.${url}.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false',
    };
    const git = async (args: string[], cwd = repo, failure?: SeatPushError) => {
      try {
        const answer = await runFile('/usr/bin/git', args, {
          cwd, env, timeout: 45_000, maxBuffer: 64 * 1024,
        });
        return answer.stdout.trim();
      } catch {
        // Git stderr may contain URL or credential-helper output. No provider
        // diagnostic is reflected to the untrusted seat.
        throw failure || new SeatPushError('provider_git_failed', 502);
      }
    };
    await git(['init', '--bare', repo], directory);
    const defaultHead = await git(['ls-remote', '--symref', url, 'HEAD']);
    const defaultRef = defaultHead.match(/^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\s+HEAD/m)?.[1];
    if (!defaultRef) throw new SeatPushError('provider_default_branch_missing', 502);
    const current = await git(['ls-remote', url, ref]);
    const oldOid = current ? current.split(/\s+/, 1)[0] : ZERO_OID;
    if (!OID.test(oldOid)) throw new SeatPushError('provider_ref_invalid', 502);
    await git(['fetch', '--no-tags', url, defaultRef]);
    if (oldOid !== ZERO_OID && oldOid !== baseOid) await git(['fetch', '--no-tags', url, ref]);
    await writeFile(bundlePath, bytes, { mode: 0o600 });
    await validateSeatBundle({ git, repo, bundlePath, baseOid, newOid, oldOid });
    // The server, not the child, chooses the compare-and-swap lease. A ref
    // move between ls-remote and this push causes a refusal upstream.
    await pushWithLease({ git, repo, url, ref, oldOid, newOid });
    return { ref, oldOid, newOid };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
