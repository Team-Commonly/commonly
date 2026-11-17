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
    AGENT_PROVISIONER_NODE_POOL: 'agent provisioning into Kubernetes pods',
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
    expect([...services].sort())
      .toEqual(['backend', 'cloudflared', 'commonly-bot', 'frontend', 'litellm', 'pg-backup', 'postgres']);
  });

  it.each(services)('%s mounts no docker socket', (service) => {
    (compose.services[service].volumes || []).forEach((volume) => expect(volume).not.toMatch(/docker\.sock/));
  });

  it.each(services)('%s publishes no host port, builds nothing, restarts, and caps its log', (service) => {
    const svc = compose.services[service];
    expect(svc).not.toHaveProperty('ports');
    expect(svc).not.toHaveProperty('build');
    expect(svc.network_mode).toBeUndefined();
    expect(svc.restart).toBe('unless-stopped');
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
