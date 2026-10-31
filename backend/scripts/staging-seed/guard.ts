/**
 * The staging seed's refusal (TASK-697). Pure, so every arm is unit-tested.
 *
 * Staging and prod are two releases of one chart in one cluster
 * (values-staging.yaml), so "the cluster I am in" proves nothing. The guard
 * therefore needs two independent signals, and refuses unless BOTH say staging:
 *
 * 1. The namespace. The operator must pass `--target=commonly-staging`, AND the
 *    namespace the process actually runs in (the in-cluster service-account
 *    namespace file, else POD_NAMESPACE) must be `commonly-staging`. Prod's
 *    namespace is `commonly-dev`.
 * 2. The databases. Neither DB host is committed (R12), so the match is on the
 *    staging markers that ARE committed:
 *    - Mongo: staging runs an in-cluster `mongodb` Service and never holds an
 *      Atlas credential (values-staging.yaml `mongodb.enabled`), so every host
 *      in MONGO_URI must be that Service. `mongodb+srv` (Atlas, prod) and any
 *      other host are refused.
 *    - Postgres: staging shares the managed Postgres service with prod but owns
 *      the `commonly_staging` database (values-staging.yaml `pgDatabase`); prod
 *      uses `defaultdb`. PG_DATABASE must be `commonly_staging`, and a host that
 *      names another namespace's in-cluster Service is refused outright.
 */

import fs from 'fs';
import path from 'path';

export const STAGING_NAMESPACE = 'commonly-staging';
export const STAGING_PG_DATABASE = 'commonly_staging';

const STAGING_MONGO_HOSTS = new Set([
  'mongodb',
  `mongodb.${STAGING_NAMESPACE}`,
  `mongodb.${STAGING_NAMESPACE}.svc`,
  `mongodb.${STAGING_NAMESPACE}.svc.cluster.local`,
]);

export interface StagingTargetSignals {
  /** The `--target=` flag, verbatim. */
  target?: string | null;
  /** The namespace the process runs in (service-account file or POD_NAMESPACE). */
  namespace?: string | null;
  mongoUri?: string | null;
  pgHost?: string | null;
  pgDatabase?: string | null;
}

export class StagingGuardError extends Error {}

const refuse = (reason: string): never => {
  throw new StagingGuardError(`staging-seed refused: ${reason}. Nothing was written.`);
};

/** Hostnames in a mongodb:// URI, lowercased, ports stripped. Never echoes credentials. */
const mongoHosts = (uri: string): string[] => {
  const match = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri);
  if (!match) return [];
  return match[1].split(',').map((host) => host.trim().toLowerCase().replace(/:\d+$/, ''));
};

export function assertStagingTarget(signals: StagingTargetSignals): void {
  const target = (signals.target || '').trim();
  if (!target) refuse(`no target given; pass --target=${STAGING_NAMESPACE}`);
  if (target !== STAGING_NAMESPACE) refuse(`--target must be ${STAGING_NAMESPACE}, got "${target}"`);

  const namespace = (signals.namespace || '').trim();
  if (!namespace) refuse('cannot determine the running namespace (no service-account namespace file, no POD_NAMESPACE)');
  if (namespace !== STAGING_NAMESPACE) refuse(`running in namespace "${namespace}", not ${STAGING_NAMESPACE}`);

  const mongoUri = (signals.mongoUri || '').trim();
  if (!mongoUri) refuse('MONGO_URI is not set');
  if (/^mongodb\+srv:/i.test(mongoUri)) refuse('MONGO_URI is a mongodb+srv (Atlas) URI; staging Mongo is the in-cluster mongodb Service');
  const hosts = mongoHosts(mongoUri);
  if (hosts.length === 0) refuse('MONGO_URI is not a mongodb:// URI');
  const foreign = hosts.filter((host) => !STAGING_MONGO_HOSTS.has(host));
  if (foreign.length) refuse(`MONGO_URI host "${foreign[0]}" is not the staging mongodb Service`);

  const pgHost = (signals.pgHost || '').trim().toLowerCase();
  if (!pgHost) refuse('PG_HOST is not set; the seed writes chat messages to PostgreSQL');
  const namespaced = /\.([a-z0-9-]+)\.svc(\.|$)/.exec(pgHost);
  if (namespaced && namespaced[1] !== STAGING_NAMESPACE) refuse(`PG_HOST names namespace "${namespaced[1]}"`);
  if (!namespaced && pgHost.includes('commonly-dev')) refuse('PG_HOST names the prod namespace commonly-dev');
  const pgDatabase = (signals.pgDatabase || '').trim();
  if (pgDatabase !== STAGING_PG_DATABASE) {
    refuse(`PG_DATABASE is "${pgDatabase || '(unset)'}", not ${STAGING_PG_DATABASE}`);
  }
}

/**
 * The seat password must never land where `git add` can reach it. Walks up from
 * the file's directory (which may not exist yet) and refuses at the first
 * `.git` entry, a directory in a checkout or a file in a worktree.
 */
export function assertCredOutOutsideRepo(
  credOut: string,
  exists: (candidate: string) => boolean = fs.existsSync,
): void {
  let dir = path.dirname(path.resolve(credOut));
  for (;;) {
    if (exists(path.join(dir, '.git'))) refuse(`--cred-out ${credOut} is inside the git checkout at ${dir}`);
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
