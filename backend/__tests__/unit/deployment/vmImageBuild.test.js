/**
 * The single VM pulls three images by one tag: commonly-backend, commonly-frontend
 * and commonly-bot (deploy/vm/docker-compose.yml, COMMONLY_IMAGE_TAG). Deploy Dev
 * built all three and then upgraded the cluster with helm; it stays disabled, since
 * its helm upgrade would scale the cluster's backend, worker and bot back up: a
 * second scheduler, Discord gateway and bot writing to the same Mongo as the VM.
 * Deploy Staging pushes only a staging frontend (`<sha8>-staging`, the staging API
 * baked in), so nothing else makes the prod frontend.
 *
 * build-vm-images.yml is Deploy Dev's gates and image builds without the cluster.
 * These tests pin both halves: it never reaches a cluster, and it builds exactly
 * what Deploy Dev built, behind exactly Deploy Dev's gates.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WORKFLOWS = path.resolve(__dirname, '../../../../.github/workflows');
const load = (name) => yaml.load(fs.readFileSync(path.join(WORKFLOWS, name), 'utf8'));

const build = load('build-vm-images.yml');
const deployDev = load('deploy-dev.yml');

// js-yaml reads the bare `on` key as true under YAML 1.1.
const triggersOf = (workflow) => workflow.on || workflow.true;
const allSteps = (workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps || []);
const stepNamed = (workflow, name) => {
  const matches = allSteps(workflow).filter((step) => step.name === name);
  expect(matches).toHaveLength(1);
  return matches[0];
};

const IMAGE_STEPS = [
  'Build + push backend image',
  'Build + push frontend image',
  'Build + push commonly-bot image',
];
const GATE_STEPS = [
  'Resolve the commit to deploy',
  'Gate on the staging-smoke commit status',
  'Gate on post-merge Service Tests',
];

describe('build-vm-images.yml builds the VM images and never reaches a cluster', () => {
  test('it runs only when dispatched', () => {
    expect(Object.keys(triggersOf(build))).toEqual(['workflow_dispatch']);
  });

  // The dev identity this workflow authenticates as can also administer the
  // cluster, so the guard is an allowlist of actions, not a list of bad ones:
  // a local composite action or a new third-party one could reach the cluster
  // without naming helm or kubectl.
  test('it uses only checkout, GCP auth and gcloud setup', () => {
    const actions = allSteps(build).filter((step) => step.uses).map((step) => step.uses.split('@')[0]);
    expect([...new Set(actions)].sort()).toEqual([
      'actions/checkout', 'google-github-actions/auth', 'google-github-actions/setup-gcloud',
    ]);
  });

  test('no step runs helm, kubectl or a cluster call', () => {
    allSteps(build).forEach((step) => {
      expect(step.run || '').not.toMatch(
        /\bhelm\b|\bkubectl\b|gcloud\s+container|get-credentials|container\.googleapis|\bgke\b/i,
      );
    });
    expect(JSON.stringify(build.env || {})).not.toMatch(/CLUSTER|NAMESPACE/);
  });

  test('it pushes exactly the three images the VM pulls', () => {
    const pushed = allSteps(build)
      .map((step) => (step.run || '').match(/\/commonly-[a-z-]+(?=\n|$)/m))
      .filter(Boolean)
      .map((match) => match[0].slice(1));
    expect(pushed.sort()).toEqual(['commonly-backend', 'commonly-bot', 'commonly-frontend']);
    const compose = fs.readFileSync(path.resolve(__dirname, '../../../../deploy/vm/docker-compose.yml'), 'utf8');
    pushed.forEach((image) => {
      expect(compose).toContain(`/${image}:\${COMMONLY_IMAGE_TAG`);
    });
  });
});

describe('build-vm-images.yml builds what Deploy Dev built, behind its gates', () => {
  test.each(IMAGE_STEPS)('%s matches Deploy Dev exactly (build args, env, push)', (name) => {
    const ours = stepNamed(build, name);
    const theirs = stepNamed(deployDev, name);
    expect(ours.run).toBe(theirs.run);
    expect(ours.env).toEqual(theirs.env);
  });

  test('the prod frontend bakes in the prod API, never the staging one', () => {
    const { run } = stepNamed(build, 'Build + push frontend image');
    expect(run).toContain('REACT_APP_API_URL=https://api.commonly.me');
    expect(run).not.toMatch(/api-staging|-staging/);
  });

  test.each(GATE_STEPS)('%s matches Deploy Dev exactly', (name) => {
    const ours = stepNamed(build, name);
    const theirs = stepNamed(deployDev, name);
    expect(ours.run).toBe(theirs.run);
    expect(ours.env).toEqual(theirs.env);
  });

  test('the build job waits for the gates and builds the commit they resolved', () => {
    const job = Object.values(build.jobs).find((j) => (j.steps || []).some((s) => s.name === IMAGE_STEPS[0]));
    const gate = Object.entries(build.jobs).find(([, j]) => (j.steps || []).some((s) => s.name === GATE_STEPS[0]));
    expect(job.needs).toBe(gate[0]);
    const checkout = job.steps.find((s) => (s.uses || '').startsWith('actions/checkout@'));
    expect(checkout.with.ref).toBe(`\${{ needs.${gate[0]}.outputs.sha }}`);
    expect(job.environment).toBe(deployDev.jobs.deploy.environment);
  });

  test('the tag is always the commit\'s short SHA: no override input', () => {
    const inputs = triggersOf(build).workflow_dispatch.inputs || {};
    expect(Object.keys(inputs).sort()).toEqual(['allow_without_staging_smoke', 'ref']);
    const { run } = stepNamed(build, 'Compute image tag');
    expect(run.trim()).toBe('echo "tag=$(git rev-parse --short=8 HEAD)" >> "$GITHUB_OUTPUT"');
  });

  // Deploy Staging also pushes backend:<sha8> and bot:<sha8>, under its own
  // group, from the same inputs; only Deploy Dev builds the same frontend tag.
  test('it shares Deploy Dev\'s concurrency group, so those two never push the frontend tag at once', () => {
    expect(build.concurrency.group).toBe(deployDev.concurrency.group);
  });
});
