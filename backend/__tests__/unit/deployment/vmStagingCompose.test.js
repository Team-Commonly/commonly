// Drift guard for staging on the prod VM (docs/deployment/vm-staging.md).
// Staging runs prod's compose file with deploy/vm/staging/compose.staging.yml on
// top, as the second project commonly-staging on the same 8 GB, 2-CPU host. These
// pin what keeps it from hurting prod: every service staging can start carries a
// hard memory and CPU cap, a low CPU weight and a high OOM score; nothing is
// published on a host port; backups and the bot stay off; and CI can only reach
// the VM through the one forced-command entry, which refuses a SHA not on main.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { REPO_ROOT } = require('../../utils/repoRoot');

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const base = yaml.load(read('deploy/vm/docker-compose.yml'));
const override = yaml.load(read('deploy/vm/staging/compose.staging.yml'));
const stagingSh = read('deploy/vm/staging/staging.sh');
const ciEntry = read('deploy/vm/staging/ci-entry.sh');
const workflow = read('.github/workflows/deploy-staging.yml');

// Compose merges an override service onto the base one key by key.
const merged = (name) => ({ ...(base.services[name] || {}), ...(override.services[name] || {}) });
const allNames = [...new Set([...Object.keys(base.services), ...Object.keys(override.services)])];
const profilesOf = (name) => merged(name).profiles || [];
// What `up` starts: no profile at all. `jobs` is the journey, which staging.sh runs.
const startable = allNames.filter((n) => profilesOf(n).length === 0 || profilesOf(n).includes('jobs'));

const toBytes = (v) => {
  const m = String(v).match(/^(\d+(?:\.\d+)?)([kmg])?b?$/i);
  if (!m) throw new Error(`unparsed mem_limit ${v}`);
  return Number(m[1]) * ({ k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] || '').toLowerCase()] || 1);
};

describe('staging on the prod VM', () => {
  test('every service staging can start is capped, deprioritised and killed first', () => {
    expect(startable.length).toBeGreaterThan(5);
    for (const name of startable) {
      const svc = merged(name);
      expect([name, svc.mem_limit]).toEqual([name, expect.anything()]);
      expect([name, svc.cpus]).toEqual([name, expect.anything()]);
      expect([name, svc.cpu_shares]).toEqual([name, 256]);
      expect([name, svc.oom_score_adj > 0]).toEqual([name, true]);
      // Nothing comes back after a VM or Docker restart, and every log is capped on prod's disk.
      expect([name, svc.restart]).toEqual([name, 'no']);
      expect([name, svc.logging && svc.logging.options['max-size']]).toEqual([name, '10m']);
    }
  });

  test('the connector joins only the tunnel its credentials file names, never a token', () => {
    // A token outranks the credentials file; the prod file passes TUNNEL_TOKEN.
    expect(override.services.cloudflared.environment).toContain('TUNNEL_TOKEN=');
    expect(override.services.cloudflared.command).toEqual(expect.arrayContaining(['--config', '/etc/cloudflared/config.yml']));
  });

  test('staging.sh takes a lock so CI and a walk never overlap', () => {
    expect(stagingSh).toMatch(/flock -w \d+ \/run\/commonly-staging\.lock/);
  });

  test('the caps add up to well under the VM, leaving prod its memory', () => {
    const mem = startable.reduce((sum, n) => sum + toBytes(merged(n).mem_limit), 0);
    const cpus = startable.reduce((sum, n) => sum + Number(merged(n).cpus), 0);
    expect(mem).toBeLessThanOrEqual(3.5 * 1024 ** 3);
    expect(cpus).toBeLessThan(2);
  });

  test('nothing is published on a host port', () => {
    for (const name of allNames) expect([name, merged(name).ports]).toEqual([name, undefined]);
  });

  test('backups and the bot are off on staging', () => {
    expect(profilesOf('pg-backup')).toEqual(['disabled-on-staging']);
    expect(profilesOf('commonly-bot')).toEqual(['disabled-on-staging']);
  });

  test('its own Mongo and mail sink; the journey targets staging, never prod', () => {
    expect(override.services.mongo.image).toMatch(/^mongo:\d+\.\d+\.\d+$/);
    const backendEnv = override.services.backend.environment.join('\n');
    expect(backendEnv).toMatch(/^MONGO_URI=mongodb:\/\/.*@mongo:27017\//m);
    expect(backendEnv).toMatch(/^SMTP2GO_BASE_URL=http:\/\/email-sink:8080\/v3$/m);
    const journey = override.services['stranger-journey'].environment.join('\n');
    expect(journey).toMatch(/^JOURNEY_API=https:\/\/api-staging\.commonly\.me$/m);
    expect(override.services.frontend.image).toMatch(/-staging$/);
  });

  test('the tunnel config comes from the untracked staging-secrets dir', () => {
    for (const v of override.services.cloudflared.volumes) expect(v).toMatch(/^\.\/staging-secrets\//);
    expect(read('deploy/vm/.gitignore')).toMatch(/^staging-secrets\/$/m);
  });

  test('staging.sh names the staging project and refuses the prod checkout', () => {
    expect(stagingSh).toMatch(/PROJECT=commonly-staging/);
    expect(stagingSh).toMatch(/-p "\$PROJECT" -f docker-compose\.yml -f staging\/compose\.staging\.yml/);
    expect(stagingSh).toMatch(/\/opt\/commonly\/deploy\/vm" \] \|\| die/);
  });

  test('the CI entry accepts four verbs and only SHAs on main', () => {
    expect(ciEntry).toMatch(/\^\[0-9a-f\]\{40\}\$/);
    expect(ciEntry).toMatch(/merge-base --is-ancestor "\$SHA" refs\/remotes\/origin\/main/);
    expect(ciEntry).toMatch(/^ {2}journey\|status\)$/m);
    expect(ciEntry).toMatch(/^ {2}down\)$/m);
  });

  test('the CI entry holds the staging lock before its first git operation', () => {
    // Two overlapping `up`s share FETCH_HEAD; without the lock one request's
    // non-main fetch can become the other's origin/main.
    const lock = ciEntry.search(/flock -w \d+ \/run\/commonly-staging\.lock/);
    const firstGit = ciEntry.search(/git -C "\$CHECKOUT"/);
    expect(lock).toBeGreaterThan(-1);
    expect(firstGit).toBeGreaterThan(lock);
    expect(stagingSh).toMatch(/if \[ -z "\$\{STAGING_LOCKED:-\}" \]/);
  });

  test('every service that reads the mail sink shares its network', () => {
    const sinkNets = merged('email-sink').networks;
    for (const name of allNames) {
      const env = [].concat(merged(name).environment || []).join('\n');
      if (name !== 'email-sink' && /email-sink:8080/.test(env)) {
        for (const n of sinkNets) expect([name, merged(name).networks || []]).toEqual([name, expect.arrayContaining([n])]);
      }
    }
  });

  test('the readiness probe is bounded, so the lock is never held on a hung response', () => {
    expect(stagingSh).toMatch(/curl -fsS --connect-timeout \d+ --max-time \d+ /);
  });

  test('Deploy Staging no longer touches the cluster and always stops staging', () => {
    expect(workflow).not.toMatch(/\bhelm\b|\bkubectl\b|get-gke-credentials/);
    expect(workflow).toMatch(/staging-ci@localhost "up \$SHA"/);
    expect(workflow).toMatch(/always\(\) && steps\.up\.outcome != 'skipped'/);
    expect(workflow).toMatch(/context="staging-smoke"/);
    // Success only for the revision the smokes tested; a late stop never takes down another run's staging.
    expect(workflow).toMatch(/\[ "\$LIVE" = "\$TAG" \]/);
    expect(workflow).toMatch(/staging-ci@localhost "down \$TAG"/);
  });
});
