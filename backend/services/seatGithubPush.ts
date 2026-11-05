/** Trusted half of the confined host seat's push channel. Git runs only in a fresh bare repo. */
import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { isWriteUnknown, markWriteUnknown } from './brokerWriteOutcome';
import type { GithubToolConnection } from './toolBrokerService';

// Typed, so tsc refuses a call that names an installation without its App (F172).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const GitHubAppService: typeof import('./githubAppService').default = require('./githubAppService');

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

/** Provider git output cap. Exported so the tests prove the checks against it. */
export const PROVIDER_GIT_MAX_BUFFER = 64 * 1024;

// The protected-path checks list names on these paths only. Every PROTECTED_PATH
// match is inside them, and PROTECTED_PATH stays the exact filter. Without the
// pathspec, a seat branch far behind the default branch lists every file the
// default branch has changed since, which overflows PROVIDER_GIT_MAX_BUFFER and
// refuses an ordinary push as provider_git_failed.
const PROTECTED_PATHSPEC = ['--', ':(icase).github', ':(icase,glob)**/CODEOWNERS'];

export const PROTECTED_PATH = (name: string): boolean => {
  const file = name.replace(/^\n+/, '');
  return /^\.github(?:\/(?:workflows|actions)(?:\/|$)|$)/i.test(file)
    || /(?:^|\/)CODEOWNERS$/i.test(file);
};

const isAncestor = async (
  git: (args: string[], cwd?: string, failure?: SeatPushError) => Promise<string>,
  repo: string, ancestor: string, descendant: string,
): Promise<boolean> => {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, descendant], repo);
    return true;
  } catch {
    return false;
  }
};

/** Git proof after the provider objects have been fetched. */
export const validateSeatBundle = async (options: {
  git: (args: string[], cwd?: string, failure?: SeatPushError) => Promise<string>;
  repo: string;
  bundlePath: string;
  baseOid: string;
  newOid: string;
  oldOid: string;
  /** The default branch tip just fetched from the provider. */
  defaultTip: string;
}): Promise<void> => {
  const { git, repo, bundlePath, baseOid, newOid, oldOid, defaultTip } = options;
  // The base must be history the seat could have started from: the default
  // branch or its own accepted tip. Existence is not enough: this repo fetches
  // a missing commit on demand, so any commit on any provider ref would exist.
  if (!(await isAncestor(git, repo, baseOid, defaultTip))
    && !(oldOid !== ZERO_OID && await isAncestor(git, repo, baseOid, oldOid))) {
    throw new SeatPushError('bundle_base_not_in_provider', 400);
  }
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
  // Names are read without rename detection and with NUL separators: a rename,
  // deletion or newline in a filename must not hide an automation-policy edit.
  // Every commit the seat introduces must leave protected paths alone, even one
  // a later commit puts back. Commits already on the default branch or the
  // accepted seat tip are not the seat's, and a merge is read only where its
  // result differs from every parent, so taking the default branch's version
  // in a merge is not an edit.
  // `--full-history`: with a pathspec, git's default simplification follows only
  // a merge's TREESAME parent, which would skip a side branch whose protected
  // edit a later commit on that branch undid.
  const history = await git(['log', '--format=', '--name-only', '-z', '--no-renames',
    '--full-history', '--diff-merges=dense-combined', newOid, `^${defaultTip}`,
    ...(oldOid !== ZERO_OID ? [`^${oldOid}`] : []), ...PROTECTED_PATHSPEC], repo);
  if (history.split('\0').some(PROTECTED_PATH)) throw new SeatPushError('push_protected_path', 403);
  // The pushed tree must carry the default branch's protected files exactly. A
  // comparison with the seat's own base would let it bring back the workflow
  // files of any earlier commit.
  const drift = await git(['diff', '--name-only', '-z', '--no-renames', defaultTip, newOid,
    ...PROTECTED_PATHSPEC], repo);
  if (drift.split('\0').some(PROTECTED_PATH)) {
    throw new SeatPushError('protected_path_behind_default', 409);
  }
};

/**
 * The failure a provider git call ends in. A push killed at its timeout may
 * already have updated the ref, so it is marked; every other git step sends no
 * write, and a push git itself refused has its answer.
 */
export const providerGitFailure = (
  args: string[],
  error: unknown,
  failure: SeatPushError = new SeatPushError('provider_git_failed', 502),
): SeatPushError => (
  args[0] === 'push' && (error as { killed?: unknown } | undefined)?.killed === true
    ? markWriteUnknown(failure) : failure
);

export const runProviderGit = async (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number },
  failure?: SeatPushError,
): Promise<string> => {
  try {
    const answer = await runFile('/usr/bin/git', args, {
      timeout: 45_000, ...options, maxBuffer: PROVIDER_GIT_MAX_BUFFER,
    });
    return answer.stdout.trim();
  } catch (error) {
    // Git stderr may contain URL or credential-helper output. No provider
    // diagnostic is reflected to the untrusted seat.
    throw providerGitFailure(args, error, failure);
  }
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
  } catch (error) {
    // Reading the ref now can't settle it: the push may land after the read.
    if (isWriteUnknown(error)) throw error;
    const latest = await git(['ls-remote', url, ref], repo).catch(() => {
      // The push may have landed and nothing here can read whether it did.
      throw markWriteUnknown(new SeatPushError('provider_git_failed', 502));
    });
    const latestOid = latest ? latest.split(/\s+/, 1)[0] : ZERO_OID;
    // Git lost the answer, not the write.
    if (latestOid === newOid) return;
    if (latestOid !== oldOid) throw new SeatPushError('stale_ref', 409);
    throw new SeatPushError('provider_git_failed', 502);
  }
};

/**
 * Fetch both lines of provider history needed for bundle and ancestry proof.
 * Commits and trees only: the proof reads ancestry and file names, never file
 * contents, so the fetch stays small however long the default branch grows.
 * The few old blobs a thin bundle deltas against arrive in one on-demand fetch
 * from the same provider while the bundle is unpacked.
 */
export const fetchProviderObjects = async (options: {
  git: (args: string[], cwd?: string, failure?: SeatPushError) => Promise<string>;
  url: string;
  defaultRef: string;
  ref: string;
  oldOid: string;
}): Promise<string> => {
  const { git, url, defaultRef, ref, oldOid } = options;
  // A filtered fetch needs a named promisor remote.
  await git(['config', 'remote.provider.url', url]);
  await git(['config', 'remote.provider.promisor', 'true']);
  await git(['config', 'extensions.partialClone', 'provider']);
  await git(['fetch', '--no-tags', '--filter=blob:none', 'provider', `+${defaultRef}:refs/provider/default`]);
  // A bundle may name the current seat tip as its prerequisite. Fetch that
  // object even if its OID equals baseOid; it need not be on the default branch.
  if (oldOid !== ZERO_OID) {
    await git(['fetch', '--no-tags', '--filter=blob:none', 'provider', `+${ref}:refs/provider/seat`]);
  }
  return git(['rev-parse', '--verify', 'refs/provider/default^{commit}']);
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
    // A push runs several remote git commands and validates the bundle in
    // between, so it never starts on a cached token: it mints its own, and a
    // fresh one again before the write (pushWithLease) below. This is the
    // broker's slowest path: about 20 git steps bounded at 45 seconds each,
    // about seven of them on the network.
    const authHeader = async () => {
      const { token } = await GitHubAppService.getInstallationToken(
        connection.installationId, connection.app, connection.repositoryId, { fresh: true },
      );
      return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    };
    const env = {
      PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `http.${url}.extraheader`,
      GIT_CONFIG_VALUE_0: await authHeader(),
      GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false',
    };
    const git = (args: string[], cwd = repo, failure?: SeatPushError) => (
      runProviderGit(args, { cwd, env }, failure)
    );
    await git(['init', '--bare', repo], directory);
    const defaultHead = await git(['ls-remote', '--symref', url, 'HEAD']);
    const defaultRef = defaultHead.match(/^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\s+HEAD/m)?.[1];
    if (!defaultRef) throw new SeatPushError('provider_default_branch_missing', 502);
    const current = await git(['ls-remote', url, ref]);
    const oldOid = current ? current.split(/\s+/, 1)[0] : ZERO_OID;
    if (!OID.test(oldOid)) throw new SeatPushError('provider_ref_invalid', 502);
    const defaultTip = await fetchProviderObjects({ git, url, defaultRef, ref, oldOid });
    await writeFile(bundlePath, bytes, { mode: 0o600 });
    await validateSeatBundle({ git, repo, bundlePath, baseOid, newOid, oldOid, defaultTip });
    // The server, not the child, chooses the compare-and-swap lease. A ref
    // move between ls-remote and this push causes a refusal upstream.
    env.GIT_CONFIG_VALUE_0 = await authHeader();
    await pushWithLease({ git, repo, url, ref, oldOid, newOid });
    return { ref, oldOid, newOid };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
