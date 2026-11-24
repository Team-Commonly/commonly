// Drift guard for the single-VM production compose (deploy/vm/, runbook
// docs/deployment/single-vm.md). The VM runs the chart's backend and LiteLLM
// with env rendered from the live Deployments (render-env-from-k8s.sh), which
// keeps only the names in each *.env.example. So every env name the chart gives
// those containers must be in the example, be a compose fixed override, or be
// excluded below with a reason; otherwise it would silently go missing on the
// VM. Each fixed override must equal what the chart sets (values.yaml merged
// with values-dev.yaml) or carry a reason for differing. The rest pins the
// file's safety properties: no host ports, no docker.sock, no worker split, no
// floating image tags, and the tunnel and bucket keys reach only their service.
//
// Reads the raw chart templates, as opsRunnerEnvMirror.test.js does: the
// backend jest job has no helm binary.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { REPO_ROOT, HELM_CHART } = require('../../utils/repoRoot');

const VM_DIR = path.join(REPO_ROOT, 'deploy/vm');
const readVm = (file) => fs.readFileSync(path.join(VM_DIR, file), 'utf8');
const readChart = (file) => fs.readFileSync(path.join(HELM_CHART, file), 'utf8');

const composeText = readVm('docker-compose.yml');
const compose = yaml.load(composeText);
const services = Object.keys(compose.services);

// Chart env names that do not reach the VM, each with why.
const EXCLUDED = {
  backend: {
    RUN_WORKER: 'one container does web and worker; unset means both',
    NATIVE_TURNS_ON_WORKER: 'only meaningful with a separate worker',
    K8S_NAMESPACE: 'agent provisioning into Kubernetes pods',
    AGENT_RUNTIME_SERVICE_ACCOUNT: 'agent provisioning into Kubernetes pods',
    CODEX_BYPASS_LITELLM: 'read only by the Kubernetes agent provisioner',
    AGENT_COMPUTER_STEEL_API_URL_TEMPLATE: 'the agent computer runs as cluster pods',
    AGENT_COMPUTER_STEEL_CDP_URL_TEMPLATE: 'the agent computer runs as cluster pods',
    AGENT_COMPUTER_ALLOWED_HOSTS: 'the agent computer runs as cluster pods',
    AGENT_COMPUTER_WAKER_URL: 'the agent computer runs as cluster pods',
    AGENT_COMPUTER_WAKER_TOKEN: 'the agent computer runs as cluster pods',
    AGENT_COMPUTER_STEEL_TOKEN: 'the agent computer runs as cluster pods',
    E2B_API_KEY: 'hosted sandbox, off on the VM',
    REDIS_HOST: 'Redis is used only with Kubernetes provisioning on; none runs here',
    REDIS_PORT: 'Redis is used only with Kubernetes provisioning on; none runs here',
    REDIS_PASSWORD: 'Redis is used only with Kubernetes provisioning on; none runs here',
    PG_CA_CERT_PATH: 'no TLS to the Postgres on the compose network',
    PG_SSL_CA_PATH: 'no TLS to the Postgres on the compose network',
    GOOGLE_APPLICATION_CREDENTIALS: "the cluster's secret-store wiring",
    GCP_PROJECT_ID: "the cluster's secret-store wiring",
    SESSION_SECRET: 'no backend code reads it',
    COMMONLY_BOT_RUNTIME_TOKEN: 'no backend code reads it',
  },
  litellm: {
    PG_PASSWORD: "only builds the chart's DATABASE_URL, which compose sets",
    CHATGPT_TOKEN_DIR: 'the ChatGPT account rotator does not run on the VM',
  },
  'commonly-bot': {},
};

// Fixed overrides that deliberately differ from what the chart sets.
const INTENTIONAL_DIFFERENCES = {
  backend: {
    PG_HOST: 'the Postgres service on the compose network',
    PG_PORT: "that service's default port",
    PG_DATABASE: "the VM's own database, from .env",
    PG_USER: "the VM's app role, from .env",
    PG_PASSWORD: "the VM's app role, from .env",
    PG_SSL_ENABLED: 'no TLS on the compose network',
    COMMONLY_API_URL: 'the backend service on the compose network',
    AGENT_PROVISIONER_K8S: 'no Kubernetes to provision agent pods into',
    AGENT_COMPUTER_ENABLED: 'the agent computer runs as cluster pods',
    SENTRY_RELEASE: "the VM's image tag",
    COMMONLY_BOT_CONFIG_PATH: "not set by the chart (Kubernetes writes a ConfigMap); the image's default path, stated",
  },
  litellm: {
    DATABASE_URL: "LiteLLM's role on the VM's Postgres, from .env",
  },
  'commonly-bot': {
    COMMONLY_BASE_URL: 'the backend service on the compose network',
    COMMONLY_AGENT_OPTIONAL: 'waits instead of exiting while runtime.json has no account (a fresh install)',
  },
};

const CHART_CONTAINERS = {
  backend: { template: 'templates/core/backend-deployment.yaml', container: 'backend', example: 'backend.env.example' },
  litellm: {
    template: 'templates/agents/litellm-deployment.yaml', container: 'litellm', example: 'litellm.env.example',
  },
  'commonly-bot': {
    template: 'templates/agents/commonly-bot-deployment.yaml',
    container: 'commonly-bot',
    example: 'commonly-bot.env.example',
  },
};

// A container's env entries in a raw template: name -> { exprs, fromRef }.
// Helm if/else branches can repeat a name, so each keeps every value line.
function chartEnv(templateFile, container) {
  const lines = readChart(templateFile).split('\n');
  let i = lines.indexOf(`      - name: ${container}`);
  if (i < 0) throw new Error(`container ${container} not found in ${templateFile}`);
  while (i < lines.length && lines[i] !== '        env:') i += 1;
  const env = new Map();
  let current = null;
  for (i += 1; i < lines.length && lines[i] !== '        volumeMounts:'; i += 1) {
    const name = lines[i].match(/^ {8}- name: ([A-Z0-9_]+)\s*$/);
    if (name) {
      current = env.get(name[1]) || { exprs: [], fromRef: false };
      env.set(name[1], current);
    } else if (current) {
      const value = lines[i].match(/^ {10}value: (.*)$/);
      if (value) current.exprs.push(value[1]);
      if (/^ {10}valueFrom:/.test(lines[i])) current.fromRef = true;
    }
  }
  if (i >= lines.length) throw new Error(`volumeMounts not found for ${container}`);
  return env;
}

const deepMerge = (base, over) => {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  Object.entries(over).forEach(([k, v]) => { out[k] = deepMerge(out[k], v); });
  return out;
};
const prodValues = deepMerge(
  yaml.load(readChart('values.yaml'), { json: true }),
  yaml.load(readChart('values-dev.yaml'), { json: true }),
);

// What a chart value line renders to, as far as the public values files say.
// Handles plain literals and {{ .Values.x | default ... | quote | toJson }};
// anything else (printf, include, mixed text) is UNRESOLVED.
const UNRESOLVED = Symbol('unresolved');
function resolveChartValue(expr) {
  const text = expr.trim();
  const whole = text.match(/^\{\{-?\s*(.*?)\s*-?\}\}$/);
  if (!whole) {
    if (text.includes('{{')) return UNRESOLVED;
    const quoted = text.match(/^"(.*)"$/);
    return quoted ? quoted[1] : text;
  }
  const term = (t) => {
    const quoted = t.match(/^"(.*)"$/);
    if (quoted) return quoted[1];
    const ref = t.match(/^\.Values\.([\w.]+)$/);
    if (!ref) return UNRESOLVED;
    return ref[1].split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), prodValues);
  };
  const [first, ...pipes] = whole[1].split('|').map((s) => s.trim());
  const cur = pipes.reduce((acc, pipe) => {
    if (acc === UNRESOLVED) return UNRESOLVED;
    const def = pipe.match(/^default\s+(.+)$/);
    if (pipe === 'toJson') return JSON.stringify(acc ?? null);
    if (def) return (acc === undefined || acc === null || acc === '' || acc === false) ? term(def[1]) : acc;
    return pipe === 'quote' ? acc : UNRESOLVED;
  }, term(first));
  return cur === undefined || cur === null || cur === UNRESOLVED ? UNRESOLVED : String(cur);
}

function serviceEnv(service) {
  const env = compose.services[service].environment || [];
  if (!Array.isArray(env)) throw new Error(`${service}.environment must use the list form`);
  return Object.fromEntries(env.map((entry) => {
    const eq = entry.indexOf('=');
    return eq < 0 ? [entry, null] : [entry.slice(0, eq), entry.slice(eq + 1)];
  }));
}

const exampleNames = (file) => readVm(file).split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => line.split('=')[0]);

describe.each(Object.keys(CHART_CONTAINERS))('single-VM %s env matches the chart', (service) => {
  const { template, container, example } = CHART_CONTAINERS[service];
  const chart = chartEnv(template, container);
  const examples = new Set(exampleNames(example));
  const fixed = serviceEnv(service);
  const excluded = EXCLUDED[service];
  const intentional = INTENTIONAL_DIFFERENCES[service];

  it('reads a plausible env set from the chart template', () => {
    expect(chart.size).toBeGreaterThan(service === 'backend' ? 80 : 8);
    expect([...chart.keys()]).toContain('LITELLM_MASTER_KEY');
  });

  it.each([...chart.keys()].sort())('%s is in the example, a fixed override, or excluded (exactly one)', (name) => {
    const places = [examples.has(name) && 'example', name in fixed && 'fixed', name in excluded && 'excluded']
      .filter(Boolean);
    expect({ name, places }).toEqual({ name, places: [expect.any(String)] });
  });

  it('lists no example name or exclusion the chart does not set', () => {
    [...examples, ...Object.keys(excluded)].forEach((name) => expect([...chart.keys()]).toContain(name));
    Object.values(excluded).forEach((reason) => expect(reason.length).toBeGreaterThan(10));
  });

  it('repeats every exclusion, with its reason, in the example file', () => {
    Object.keys(excluded).forEach((name) => expect(readVm(example)).toMatch(new RegExp(`^#.*\\b${name}\\b`, 'm')));
  });

  it.each(Object.keys(fixed))('fixed override %s equals the chart, or differs for a stated reason', (name) => {
    const value = fixed[name];
    expect(value).not.toBeNull();
    const entry = chart.get(name);
    const chartValues = (entry ? entry.exprs : []).map(resolveChartValue).filter((v) => v !== UNRESOLVED);
    const equal = !value.includes('${') && chartValues.includes(value);
    if (equal) expect(intentional).not.toHaveProperty(name);
    else expect({ name, reason: intentional[name] }).toEqual({ name, reason: expect.stringMatching(/.{10,}/) });
  });

  it('keeps no stale intentional difference', () => {
    Object.keys(intentional).forEach((name) => expect(fixed).toHaveProperty(name));
  });

  it(`reads the rest from ${service}.env only`, () => {
    expect(compose.services[service].env_file).toEqual([`./${service}.env`]);
  });
});

describe('single-VM env files', () => {
  it('NODE_ENV is what the chart runs today', () => {
    expect(serviceEnv('backend').NODE_ENV).toBe(prodValues.backend.env.nodeEnv);
  });

  it('backup.env carries only names the backend has', () => {
    const backend = chartEnv(CHART_CONTAINERS.backend.template, 'backend');
    expect(exampleNames('backup.env.example')).toEqual(['MONGO_URI']);
    expect([...backend.keys()]).toContain('MONGO_URI');
    expect(compose.services['pg-backup'].env_file).toEqual(['./backup.env']);
  });

  it('the stack .env.example names exactly the variables compose interpolates', () => {
    const interpolated = new Set([...composeText.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]));
    expect(new Set(exampleNames('.env.example'))).toEqual(interpolated);
  });

  it('every example carries names only, never a value', () => {
    // Every *.example in the folder, so a new service's example can't be missed.
    const examples = fs.readdirSync(VM_DIR).filter((file) => file.endsWith('.example'));
    expect(examples).toEqual(expect.arrayContaining(['.env.example', 'backend.env.example',
      'litellm.env.example', 'backup.env.example', 'commonly-bot.env.example']));
    examples.forEach((file) => {
      readVm(file).split('\n').filter((line) => line && !line.startsWith('#'))
        .forEach((line) => expect({ file, line }).toEqual({ file, line: expect.stringMatching(/^[A-Z][A-Z0-9_]*=$/) }));
    });
  });

  it('the tunnel token and bucket keys reach only their own service', () => {
    services.forEach((service) => {
      const text = JSON.stringify(compose.services[service].environment || []);
      if (service !== 'cloudflared') expect(text).not.toContain('TUNNEL_TOKEN');
      if (service !== 'pg-backup') expect(text).not.toMatch(/BACKUP_S3_/);
      (compose.services[service].env_file || []).forEach((file) => expect(file).not.toMatch(/(^|\/)\.env$/));
    });
  });

  it('the render script passes its Python suite', () => {
    const r = spawnSync('python3', ['-I', path.join(__dirname, 'render_env_from_k8s_test.py'),
      path.join(VM_DIR, 'render_env_from_k8s.py')], { encoding: 'utf8', timeout: 60000 });
    if (r.error) throw r.error;
    expect(`${r.stdout}${r.stderr}`).toMatch(/\nOK\s*$/);
  });

  // The proof that compose itself reads the rendered quoting byte for byte:
  // PEM keys, quotes, $, # and backslashes. Needs docker compose; skipped where
  // there is none (the containerised ./dev.sh test).
  const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
  (hasCompose ? it : it.skip)('docker compose reads every rendered value exactly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-env-'));
    try {
      const emit = spawnSync('python3', ['-I', path.join(__dirname, 'render_env_from_k8s_test.py'),
        path.join(VM_DIR, 'render_env_from_k8s.py'), '--emit', dir], { encoding: 'utf8', timeout: 60000 });
      expect(emit.status).toBe(0);
      fs.writeFileSync(
        path.join(dir, 'docker-compose.yml'),
        'services:\n  probe:\n    image: alpine:3.20\n    env_file: [backend.env]\n',
      );
      const out = spawnSync(
        'docker', 
        ['compose', '--project-directory', dir, 'config', '--format', 'json'],
        { encoding: 'utf8', timeout: 60000 },
      );
      expect(out.status).toBe(0);
      // `config` prints every literal $ as $$, so it can be read back in.
      const env = Object.fromEntries(Object.entries(JSON.parse(out.stdout).services.probe.environment)
        .map(([k, v]) => [k, v.replace(/\$\$/g, '$')]));
      expect(env).toEqual(JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('single-VM compose: safety properties', () => {
  it('runs the expected services, with no Mongo service', () => {
    const alwaysOn = services.filter((s) => !compose.services[s].profiles);
    expect([...alwaysOn].sort())
      .toEqual(['backend', 'cloudflared', 'commonly-bot', 'frontend', 'litellm', 'pg-backup', 'postgres']);
  });

  // Profiled services are one-shot jobs a host cron runs with `run --rm`;
  // `up -d` never starts them. Only the jobs profile is allowed.
  it('keeps one-shot jobs behind the jobs profile, and only the known ones', () => {
    const jobs = services.filter((s) => compose.services[s].profiles);
    expect(jobs).toEqual(['stranger-journey']);
    jobs.forEach((s) => expect(compose.services[s].profiles).toEqual(['jobs']));
  });

  // A full `docker compose up` starts LiteLLM beside its callers, and a model
  // call before LiteLLM listens fails with ECONNREFUSED. So they wait for its
  // readiness, but optionally: a LiteLLM that never gets healthy costs a compose
  // warning, never a backend that does not start or a roll that fails.
  it.each(['backend', 'commonly-bot'])('%s waits for LiteLLM to be ready, without needing it', (service) => {
    expect(compose.services[service].depends_on.litellm).toEqual({ condition: 'service_healthy', required: false });
  });

  it("checks LiteLLM's readiness with the image's own Python", () => {
    const { test, start_period: startPeriod } = compose.services.litellm.healthcheck;
    expect(test.slice(0, 2)).toEqual(['CMD', 'python3']);
    expect(test.join(' ')).toContain('http://127.0.0.1:4000/health/readiness');
    expect(startPeriod).toBeDefined();
  });

  // The chart's LiteLLM checks at boot that the injection-guard loaded and
  // still blocks a known jailbreak line, and logs injection_guard_degraded when
  // it doesn't. That line is the alert's only producer, so the VM runs the same
  // check, word for word, and starts LiteLLM either way.
  const GUARD_CHECK = `-I - <<'PYEOF' || echo '{"alarm":"injection_guard_degraded"`;
  const guardCheck = (script) => {
    const lines = script.split('\n');
    const start = lines.findIndex((line) => line.includes(GUARD_CHECK));
    if (start < 0) return null;
    const end = lines.findIndex((line, i) => i > start && line.trim() === 'PYEOF');
    if (end < 0) return null;
    const indent = lines[start].match(/^ */)[0].length;
    return lines.slice(start, end + 1).map((line) => line.slice(indent)).join('\n');
  };

  it("runs the chart's injection-guard boot check before LiteLLM starts, as an alarm, never a stop", () => {
    const chartCheck = guardCheck(readChart('templates/agents/litellm-deployment.yaml'));
    expect(chartCheck).not.toBeNull();
    const [script] = compose.services.litellm.command;
    // Compose reads `$$` as a literal `$`, so every `$` in the chart's copy must
    // be `$$` here. Comparing that way, a bare `$` compose would blank fails too.
    // (A function, because a replacement string reads `$$` as one `$`.)
    expect(guardCheck(script)).toBe(chartCheck.replaceAll('$', () => '$$'));
    expect(script).toContain('PYBIN=/app/.venv/bin/python3');
    expect(script.indexOf('PYBIN=')).toBeLessThan(script.indexOf(GUARD_CHECK));
    expect(script.indexOf(GUARD_CHECK)).toBeLessThan(script.indexOf('exec litellm --config /app/config.yaml'));
    expect(script).not.toMatch(/set -e|exit 1/);
  });

  it("runs the LiteLLM image the chart's guard check is proven against in CI", () => {
    const values = readChart('values.yaml');
    const [, repository, tag] = values.match(/^litellm:\n[\s\S]*?\n {4}repository: (\S+)[\s\S]*?\n {4}tag: (\S+)/m);
    expect(compose.services.litellm.image).toBe(`${repository}:${tag}`);
  });

  // Alert filters on the VM read the service off each log line, not its text.
  it('stamps every log line with its compose service', () => {
    expect(compose['x-logging'].driver).toBe('json-file');
    expect(compose['x-logging'].options.labels).toBe('com.docker.compose.service');
  });

  it.each(services)('%s mounts no docker socket', (service) => {
    (compose.services[service].volumes || []).forEach((volume) => expect(volume).not.toMatch(/docker\.sock/));
  });

  it.each(services)('%s publishes no host port, builds nothing, restarts, and caps its log', (service) => {
    const svc = compose.services[service];
    expect(svc).not.toHaveProperty('ports');
    expect(svc).not.toHaveProperty('build');
    expect(svc.network_mode).toBeUndefined();
    // A long-running service restarts; a one-shot job must not, or a failed
    // journey would loop against prod.
    expect(svc.restart).toBe(svc.profiles ? 'no' : 'unless-stopped');
    expect(svc.logging).toEqual(compose['x-logging']);
  });

  it.each(services)('%s pins its image to a tag, never main or latest', (service) => {
    const { image } = compose.services[service];
    // The tag is the last `:part`, or a whole `${VAR...}` that holds one.
    const [, tag] = image.match(/:(\$\{[^}]+\}|[^:/]+)$/) || [];
    expect(tag).toBeDefined();
    if (tag.startsWith('${')) {
      expect(tag).toMatch(/^\$\{COMMONLY_IMAGE_TAG:\?/);
    } else {
      expect(tag).not.toMatch(/^(latest|main|main-.*|stable|.*-stable)$/);
      expect(tag).toMatch(/^v?\d/);
    }
  });

  it('runs one backend that is web and worker, with no docker socket or source mount', () => {
    const { backend } = compose.services;
    const env = serviceEnv('backend');
    expect(backend.deploy?.replicas ?? 1).toBe(1);
    expect(env).not.toHaveProperty('RUN_WORKER');
    expect(env).not.toHaveProperty('NATIVE_TURNS_ON_WORKER');
    expect(exampleNames('backend.env.example')).not.toContain('RUN_WORKER');
    // Read-only, except the one directory it shares with commonly-bot.
    const writable = (backend.volumes || []).filter((volume) => !/:ro$/.test(volume));
    expect(writable).toEqual(['./commonly-bot-state:/app/external/commonly-bot-state']);
    expect(backend.healthcheck.test.join(' ')).toContain('/api/health');
  });

  it("shares commonly-bot's accounts file: the backend writes where the bot reads", () => {
    const backendPath = serviceEnv('backend').COMMONLY_BOT_CONFIG_PATH;
    const botPath = serviceEnv('commonly-bot').COMMONLY_AGENT_CONFIG_PATH;
    const mountOf = (service, file) => compose.services[service].volumes
      .map((volume) => volume.split(':'))
      .find(([, target]) => file.startsWith(`${target}/`));
    const [backendSource, backendTarget] = mountOf('backend', backendPath);
    const [botSource, botTarget, botMode] = mountOf('commonly-bot', botPath);
    expect(botSource).toBe(backendSource);
    expect(botMode).toBe('ro');
    expect(backendPath.slice(backendTarget.length)).toBe(botPath.slice(botTarget.length));
    expect(readVm('.gitignore')).toMatch(/^commonly-bot-state\/$/m);
  });

  it('backs up with the same Postgres image the database runs, and checks before pruning', () => {
    expect(compose.services['pg-backup'].image).toBe(compose.services.postgres.image);
    const script = readVm('backup.sh');
    expect(script).toMatch(/pg_dump [^\n]*\\\n[^\n]*-Fc/);
    expect(script).toMatch(/mongodump --config=/);
    expect(script).not.toMatch(/mongodump[^\n]*--uri/);
    expect(script).toMatch(/pg_restore -l/);
    expect(script.indexOf('pg_restore -l')).toBeLessThan(script.indexOf('rclone delete'));
  });
});

// Runs the real backup.sh with stub tools on PATH, so the Postgres-only mode is
// proven by behaviour: it must upload one Postgres dump and must not dump
// MongoDB, prune, or write the success stamp the health check reads.
describe('backup.sh Postgres-only runs', () => {
  const stub = (dir, name, body) => {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  const run = (args, extraEnv = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-backup-'));
    const log = path.join(dir, 'calls.log');
    // pg_dump writes the file named after -f; pg_restore -l lists table data.
    stub(dir, 'pg_dump', `while [ $# -gt 0 ]; do [ "$1" = -f ] && echo dump > "$2"; shift; done; echo pg_dump >> "${log}"`);
    stub(dir, 'pg_restore', 'echo "1; 0 0 TABLE DATA public messages owner"');
    stub(dir, 'rclone', `echo "rclone $*" >> "${log}"`);
    stub(dir, 'mongodump', `echo mongodump >> "${log}"`);
    stub(dir, 'apk', `echo apk >> "${log}"; exit 1`);
    // A regressed bare call would fall into the loop's sleep; fail fast instead of hanging.
    stub(dir, 'sleep', `echo sleep >> "${log}"; exit 1`);
    const env = {
      PATH: `${dir}:/usr/bin:/bin`,
      PG_ADMIN_USER: 'admin', PG_ADMIN_PASSWORD: 'x', PG_DATABASE: 'commonly',
      BACKUP_S3_ENDPOINT: 'https://r2.invalid', BACKUP_S3_BUCKET: 'b',
      BACKUP_S3_ACCESS_KEY_ID: 'k', BACKUP_S3_SECRET_ACCESS_KEY: 's',
      BACKUP_S3_PREFIX: 'nightly', MONGO_URI: 'mongodb://u:p@h/db',
      ...extraEnv,
    };
    const r = spawnSync('sh', [path.join(VM_DIR, 'backup.sh'), ...args], { env, encoding: 'utf8', timeout: 20000 });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...r, calls };
  };

  it('pg-once uploads one Postgres dump and nothing else', () => {
    const r = run(['pg-once']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/postgres backup uploaded: nightly\/postgres\/postgres-\d{8}-\d{6}\.dump/);
    expect(r.calls).toMatch(/^pg_dump$/m);
    expect(r.calls).toMatch(/^rclone copyto \S+ bucket:b\/nightly\/postgres\/postgres-\d{8}-\d{6}\.dump$/m);
    expect(r.calls).not.toMatch(/mongodump/);
    expect(r.calls).not.toMatch(/rclone delete/);
    expect(r.calls).not.toMatch(/^apk$/m);
    // The success stamp's directory is never created by a Postgres-only run.
    expect(r.stdout).not.toMatch(/backup complete/);
  });

  it('a bare or unknown call prints usage and runs nothing, so it can never start a second loop', () => {
    for (const args of [[], ['bogus']]) {
      // An empty PG_ADMIN_USER proves the command is checked before any configuration is read.
      const r = run(args, { PG_ADMIN_USER: '' });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/usage: commonly-backup loop\|once/);
      // apk (tool install), sleep (the loop) and every backup tool log here.
      expect(r.calls).toBe('');
    }
  });

  it('rejects a Postgres cadence outside 0 to 24 hours before doing anything', () => {
    const r = run(['pg-once'], { BACKUP_PG_EVERY_HOURS: '25' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/BACKUP_PG_EVERY_HOURS must be 0 to 24/);
    expect(r.calls).toBe('');
  });

  // A fake clock: date +%s reads it, sleep and pg_dump advance it, and the
  // third sleep ends the loop by signalling the script.
  const runLoop = (startSecs, pgDumpSecs) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-backup-loop-'));
    const log = path.join(dir, 'calls.log');
    const clock = path.join(dir, 'clock');
    const sleeps = path.join(dir, 'sleeps');
    fs.writeFileSync(clock, String(startSecs));
    fs.writeFileSync(sleeps, '0');
    const tick = (n) => `c=$(cat "${clock}"); echo $((c + ${n})) > "${clock}"`;
    stub(dir, 'date', `case "$*" in *+%s*) cat "${clock}" ;; *) exec /bin/date "$@" ;; esac`);
    stub(dir, 'sleep', `n=$(($(cat "${sleeps}") + 1)); echo $n > "${sleeps}"; echo "sleep $1" >> "${log}"; [ $n -ge 3 ] && kill -TERM $PPID; ${tick('$1')}`);
    stub(dir, 'pg_dump', `while [ $# -gt 0 ]; do [ "$1" = -f ] && echo dump > "$2"; shift; done; echo pg_dump >> "${log}"; ${tick(pgDumpSecs)}`);
    stub(dir, 'pg_restore', 'echo "1; 0 0 TABLE DATA public messages owner"');
    stub(dir, 'rclone', 'true');
    stub(dir, 'mongodump', `echo mongodump >> "${log}"`);
    stub(dir, 'apk', 'exit 1');
    const env = {
      PATH: `${dir}:/usr/bin:/bin`,
      PG_ADMIN_USER: 'admin', PG_ADMIN_PASSWORD: 'x', PG_DATABASE: 'commonly',
      BACKUP_S3_ENDPOINT: 'https://r2.invalid', BACKUP_S3_BUCKET: 'b',
      BACKUP_S3_ACCESS_KEY_ID: 'k', BACKUP_S3_SECRET_ACCESS_KEY: 's',
      BACKUP_S3_PREFIX: 'nightly', MONGO_URI: 'mongodb://u:p@h/db',
      BACKUP_HOUR_UTC: '1', BACKUP_PG_EVERY_HOURS: '6',
    };
    spawnSync('sh', [path.join(VM_DIR, 'backup.sh'), 'loop'], { env, encoding: 'utf8', timeout: 20000 });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    fs.rmSync(dir, { recursive: true, force: true });
    return calls;
  };

  it('runs the nightly backup at once when a Postgres-only run overran its slot', () => {
    // 23:00 UTC: the 00:00 Postgres slot comes first and its dump takes 65 minutes,
    // finishing at 01:05, past the 01:00 nightly slot.
    const calls = runLoop(82800, 3900);
    expect(calls.slice(0, 4)).toEqual(['sleep 3600', 'pg_dump', 'pg_dump', 'mongodump']);
  });

  it('keeps the normal wait when a Postgres-only run finishes before the nightly slot', () => {
    const calls = runLoop(82800, 60);
    expect(calls.slice(0, 5)).toEqual(['sleep 3600', 'pg_dump', 'sleep 3540', 'pg_dump', 'mongodump']);
  });

  it('passes the cadence through to pg-backup, off unless set', () => {
    expect(compose.services['pg-backup'].environment)
      .toContain('BACKUP_PG_EVERY_HOURS=${BACKUP_PG_EVERY_HOURS:-0}');
  });
});

// The synthetic stranger journey moved off the GKE CronJob (2026-11-18, when prod moved to the single VM).
// It must stay a one-shot job: `up -d` never starts it, it never restarts, and
// it runs the chart's own script so the two copies cannot drift.
describe('stranger-journey is a one-shot job, not a service', () => {
  const svc = compose.services['stranger-journey'];

  it('sits behind the jobs profile so up -d leaves it alone, and never restarts', () => {
    expect(svc.profiles).toEqual(['jobs']);
    expect(svc.restart).toBe('no');
    expect(svc.healthcheck).toBeUndefined();
  });

  it('runs the chart script read-only under a hard timeout, against the public API', () => {
    expect(svc.volumes).toContain('../../k8s/helm/commonly/files/stranger-journey.py:/journey/stranger-journey.py:ro');
    expect(fs.existsSync(path.join(REPO_ROOT, 'k8s/helm/commonly/files/stranger-journey.py'))).toBe(true);
    expect(svc.command.slice(0, 2)).toEqual(['timeout', '900']);
    expect(svc.environment).toContain('JOURNEY_API=https://api.commonly.me');
  });

  it('runs as nobody, read-only, with no capabilities, as the CronJob did', () => {
    expect(svc.user).toBe('65534:65534');
    expect(svc.read_only).toBe(true);
    expect(svc.cap_drop).toEqual(['ALL']);
    expect(svc.security_opt).toContain('no-new-privileges:true');
  });

  it('carries no secret and no database: it is a stranger', () => {
    expect(svc.env_file).toBeUndefined();
    expect(svc.depends_on).toBeUndefined();
    expect(JSON.stringify(svc.environment)).not.toMatch(/MONGO|PG_|TOKEN|SECRET|PASSWORD|INVITE/);
  });

  it('logs through the shared anchor, so its lines carry the compose service', () => {
    expect(svc.logging).toEqual(compose['x-logging']);
  });
});
