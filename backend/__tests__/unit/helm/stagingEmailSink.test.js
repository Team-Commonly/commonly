const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { HELM_CHART } = require('../../utils/repoRoot');

// Staging limits sign-up to team domains, so with no email delivery register
// refused every email sign-up (503 INSTANCE_VERIFICATION_UNAVAILABLE) and no
// walk could reach a verification link (Cofounder 11-09). email.sink puts an
// in-cluster stand-in for SMTP2GO there. It must stay off prod: on prod, real
// people's verification mail would never leave the cluster.
const chart = HELM_CHART;
const read = (f) => fs.readFileSync(path.join(chart, f), 'utf8');
const base = yaml.load(read('values.yaml'), { json: true });
const dev = yaml.load(read('values-dev.yaml'), { json: true });
const staging = yaml.load(read('values-staging.yaml'), { json: true });

describe('email.sink: on for staging only', () => {
  test('values', () => {
    expect(base.email.sink.enabled).toBe(false);
    expect(dev.email?.sink?.enabled).not.toBe(true);
    expect(staging.email.enabled).toBe(false);
    expect(staging.email.sink.enabled).toBe(true);
    expect(staging.email.sink.fromEmail).toMatch(/@staging\.commonly\.me$/);
    expect(staging.backend.env.frontendUrl).not.toBe('https://commonly.me');
  });

  // The backend jest job has no helm binary, so these read the template text;
  // the render block below covers the rest where helm is installed.
  test.each(['templates/core/backend-deployment.yaml', 'templates/ops/ops-runner-deployment.yaml'])(
    '%s sends to the sink only when it is on, and to SMTP2GO otherwise',
    (file) => {
      const text = read(file);
      const block = text.slice(text.indexOf('# Email Configuration (SMTP2GO)'));
      const sinkBranch = block.slice(0, block.indexOf('{{- else }}'));
      expect(sinkBranch).toContain('{{- if .Values.email.sink.enabled }}');
      expect(sinkBranch).toContain('email-sink.%s.svc.cluster.local/v3');
      expect(sinkBranch).not.toContain('secretKeyRef');
      const elseBranch = block.slice(block.indexOf('{{- else }}'), block.indexOf('{{- end }}'));
      expect(elseBranch.match(/key: SMTP2GO_/g)).toHaveLength(4);
    },
  );

  test('the sink template refuses prod and real delivery beside it', () => {
    const text = read('templates/core/email-sink.yaml');
    expect(text).toMatch(/if \.Values\.email\.sink\.enabled/);
    expect(text).toMatch(/if \.Values\.email\.enabled \}\}\n\{\{- fail/);
    expect(text).toMatch(/"https:\/\/commonly\.me" \}\}\n\{\{- fail/);
  });
});

const helmOk = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status === 0;
const render = (...args) => spawnSync(
  'helm',
  ['template', 'commonly', chart, '-f', path.join(chart, 'values.yaml'), ...args],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const docsOf = (r) => {
  expect(r.status).toBe(0);
  // helm 4 can write the manifest to stderr; an empty render must not pass.
  const out = r.stdout.trim() ? r.stdout : r.stderr;
  expect(out.split('\n').length).toBeGreaterThan(1000);
  return yaml.loadAll(out).filter(Boolean);
};
const smtpEnv = (docs, name) => {
  const d = docs.find((x) => x.kind === 'Deployment' && x.metadata.name === name);
  return Object.fromEntries(d.spec.template.spec.containers[0].env
    .filter((e) => e.name.startsWith('SMTP2GO_'))
    .map((e) => [e.name, e.value ?? `secret:${e.valueFrom.secretKeyRef.key}`]));
};

(helmOk ? describe : describe.skip)('helm render', () => {
  const stagingValues = ['-f', path.join(chart, 'values-staging.yaml')];
  const devValues = ['-f', path.join(chart, 'values-dev.yaml')];

  const sinkEnv = {
    SMTP2GO_API_KEY: 'email-sink',
    SMTP2GO_FROM_EMAIL: staging.email.sink.fromEmail,
    SMTP2GO_FROM_NAME: 'Commonly (staging)',
    SMTP2GO_BASE_URL: 'http://email-sink.commonly-staging.svc.cluster.local/v3',
  };

  test('staging: web and worker mail the sink; its token comes from the store', () => {
    const docs = docsOf(render(...stagingValues));
    const sink = docs.filter((d) => d.metadata.name === 'email-sink').map((d) => d.kind).sort();
    expect(sink).toEqual(['Deployment', 'ExternalSecret', 'Service']);
    ['backend', 'backend-worker'].forEach((name) => expect(smtpEnv(docs, name)).toEqual(sinkEnv));
    const es = docs.find((d) => d.kind === 'ExternalSecret' && d.metadata.name === 'email-sink');
    expect(es.spec.target.name).toBe('email-sink');
    expect(es.spec.data).toEqual([{
      secretKey: 'read-token', remoteRef: { key: 'commonly-staging-email-sink-read-token' },
    }]);
  });

  // Chart Lint diffs two renders; a token minted in the chart broke that.
  test('staging renders the same twice', () => {
    const sinkDocs = () => docsOf(render(...stagingValues)).filter((d) => d.metadata.name === 'email-sink');
    expect(sinkDocs()).toEqual(sinkDocs());
  });

  test('ops-runner, where it runs, mails the sink too', () => {
    const docs = docsOf(render(...stagingValues, '--set', 'opsRunner.enabled=true'));
    expect(smtpEnv(docs, 'ops-runner')).toEqual(sinkEnv);
  });

  test('dev: no sink, SMTP2GO from the secret as before', () => {
    const docs = docsOf(render(...devValues));
    expect(docs.filter((d) => d.metadata.name === 'email-sink')).toEqual([]);
    expect(smtpEnv(docs, 'backend')).toEqual({
      SMTP2GO_API_KEY: 'secret:SMTP2GO_API_KEY',
      SMTP2GO_FROM_EMAIL: 'secret:SMTP2GO_FROM_EMAIL',
      SMTP2GO_FROM_NAME: 'secret:SMTP2GO_FROM_NAME',
      SMTP2GO_BASE_URL: 'secret:SMTP2GO_BASE_URL',
    });
  });

  test.each([
    ['dev with the sink turned on', [...devValues, '--set', 'email.enabled=false', '--set', 'email.sink.enabled=true',
      '--set', 'email.sink.fromEmail=a@b.io'], /refused where frontendUrl is https:\/\/commonly\.me/],
    ['staging with real delivery beside it', [...stagingValues, '--set', 'email.enabled=true'], /are exclusive/],
    ['staging without a sender', [...stagingValues, '--set', 'email.sink.fromEmail='], /fromEmail is required/],
  ])('refuses %s', (_label, args, message) => {
    const r = render(...args);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(message);
  });
});
